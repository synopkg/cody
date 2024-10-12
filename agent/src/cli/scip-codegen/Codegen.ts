import fspromises from 'node:fs/promises'
import path from 'node:path'
import dedent from 'dedent'
import {
    BaseCodegen,
    type ConstantType,
    type DiscriminatedUnion,
    type DiscriminatedUnionMember,
} from './BaseCodegen'

import { CodePrinter } from '../../../../vscode/src/completions/context/retrievers/tsc/CodePrinter'
import type { ConsoleReporter } from './ConsoleReporter'
import { type Diagnostic, Severity } from './Diagnostic'
import type { Formatter } from './Formatter'
import type { SymbolTable } from './SymbolTable'
import type { CodegenOptions } from './command'
import { CSharpEmitter } from './emitters/CSharpEmitter'
import type { DataClassOptions, Emitter, Enum, Member } from './emitters/Emitter'
import { JavaEmitter } from './emitters/JavaEmitter'
import { KotlinEmitter } from './emitters/KotlinEmitter'
import { resetOutputPath } from './resetOutputPath'
import { scip } from './scip'
import { stringLiteralType } from './stringLiteralType'
import { capitalize, isTypescriptKeyword, typescriptKeyword, typescriptKeywordSyntax } from './utils'

interface DocumentContext {
    f: Formatter
    p: CodePrinter
    symtab: SymbolTable
}

export enum TargetLanguage {
    Java = 'java',
    Kotlin = 'kotlin',
    CSharp = 'csharp',
}
export class Codegen extends BaseCodegen {
    public queue: scip.SymbolInformation[] = []
    public generatedSymbols = new Set<string>()
    public stringLiteralConstants = new Set<string>()
    private emitter: Emitter

    constructor(
        language: TargetLanguage,
        options: CodegenOptions,
        symtab: SymbolTable,
        reporter: ConsoleReporter
    ) {
        super(options, symtab, reporter)
        this.emitter = this.getEmitter(language)
    }

    private getEmitter(language: TargetLanguage): Emitter {
        switch (language) {
            case TargetLanguage.Kotlin:
                return new KotlinEmitter(this.options, this.symtab, this)
            case TargetLanguage.Java:
                return new JavaEmitter(this.options, this.symtab, this)
            case TargetLanguage.CSharp:
                return new CSharpEmitter(this.options, this.symtab, this)
        }
    }

    public async run(): Promise<void> {
        await resetOutputPath(this.options.output)
        await this.writeNullAlias()
        await this.writeProtocolInterface(
            'CodyAgentServer',
            BaseCodegen.protocolSymbols.client.requests,
            BaseCodegen.protocolSymbols.client.notifications
        )
        await this.writeProtocolInterface(
            'CodyAgentClient',
            BaseCodegen.protocolSymbols.server.requests,
            BaseCodegen.protocolSymbols.server.notifications
        )
        let info = this.queue.pop()
        while (info) {
            if (!this.generatedSymbols.has(info.symbol)) {
                await this.writeType(info)
                this.generatedSymbols.add(info.symbol)
            }
            info = this.queue.pop()
        }

        await this.writeSerializationAdapters()
        await this.writeStringLiteralConstants()

        await fspromises.mkdir(this.options.output, { recursive: true })
    }

    private startDocument(): DocumentContext & {
        c: DocumentContext
    } {
        const context: DocumentContext = {
            f: this.emitter.formatter,
            p: new CodePrinter(),
            symtab: this.symtab,
        }
        return { ...context, c: context }
    }

    private async writeSerializationAdapters(): Promise<void> {
        if (this.discriminatedUnions.size === 0) {
            return
        }
        const { p } = this.startDocument()

        const discriminatedUnions = [...this.discriminatedUnions.keys()]
            .sort()
            .map(symbol => this.symtab.info(symbol).display_name)
        this.emitter.emitSerializationAdapter(p, discriminatedUnions)
        await fspromises.writeFile(
            path.join(this.options.output, `ProtocolTypeAdapters.${this.emitter.getFileType()}`),
            p.build()
        )
    }

    private async writeStringLiteralConstants(): Promise<void> {
        if (this.stringLiteralConstants.size === 0) {
            return
        }
        const { p } = this.startDocument()
        const constants = [...this.stringLiteralConstants.values()].sort()
        this.emitter.emitStringLiteralConstants(p, constants)
        await fspromises.writeFile(
            path.join(this.options.output, `Constants.${this.emitter.getFileType()}`),
            p.build()
        )
    }

    private async writeNullAlias(): Promise<void> {
        const { p } = this.startDocument()
        this.emitter.emitNullAlias(p)
        await fspromises.writeFile(
            path.join(this.options.output, `Null.${this.emitter.getFileType()}`),
            p.build()
        )
    }

    private async writeSealedClass(
        { p, f, symtab }: DocumentContext,
        name: string,
        info: scip.SymbolInformation,
        { members, ...unionArgs }: DiscriminatedUnion
    ): Promise<void> {
        const isHandledCase = new Set<ConstantType>()
        const union: DiscriminatedUnion = { ...unionArgs, members: [] }
        for (const member of members) {
            if (isHandledCase.has(member.value)) {
                // There's a bug in ContextProvider where
                // two cases have the same discriminator
                // 'search'
                this.reporter.warn(info.symbol, `duplicate discriminator value ${member.value}`)
                continue
            }
            isHandledCase.add(member.value)
            union.members.push(member)
        }
        this.emitter.startSealedClass(p, { name, info, union })
        for (const member of union.members) {
            const typeName = this.emitter.formatter.discriminatedUnionTypeName(union, member)
            const info = member.type.has_type_ref
                ? this.symtab.info(member.type.type_ref.symbol)
                : new scip.SymbolInformation({
                      display_name: typeName,
                      signature: new scip.Signature({
                          value_signature: new scip.ValueSignature({ tpe: member.type }),
                      }),
                  })
            this.writeDataClass({ p, f, symtab }, typeName, info, {
                innerClass: true,
                parentClass: name,
            })
        }
        this.emitter.closeSealedClass?.(p, { name, info, union })
    }

    private async writeDataClass(
        { p, f, symtab }: DocumentContext,
        name: string,
        info: scip.SymbolInformation,
        params?: Partial<DataClassOptions>
    ): Promise<void> {
        try {
            await this.writeDataClassUnsafe({ p, f, symtab }, name, info, params)
        } catch (e) {
            const errorMessage = `Failed to handle class ${info.symbol}. To fix this problem, consider skipping this type by adding the symbol to "ignoredInfoSymbol" in Formatter.ts\n${e}`
            this.reporter.error(info.symbol, errorMessage)
        }
    }

    private async writeDataClassUnsafe(
        { p, f, symtab }: DocumentContext,
        name: string,
        info: scip.SymbolInformation,
        params?: Partial<DataClassOptions>
    ): Promise<void> {
        if (info.kind === scip.SymbolInformation.Kind.Class) {
            this.reporter.warn(
                info.symbol,
                `classes should not be exposed in the agent protocol because they don't serialize to JSON.`
            )
        }
        const generatedName = new Set<string>()
        const enums: Enum[] = []
        const members: Member[] = []
        for (const memberSymbol of this.infoProperties(info)) {
            if (
                this.emitter.formatter.ignoredProperties.find(ignoredProperty =>
                    memberSymbol.includes(ignoredProperty)
                )
            ) {
                continue
            }
            if (memberSymbol.endsWith('().')) {
                // Ignore method members because they should not leak into
                // the protocol in the first place because functions don't
                // have meaningful JSON serialization. The most common cause
                // is that a class leaks into the protocol.
                continue
            }
            const member = symtab.info(memberSymbol)

            if (generatedName.has(member.display_name)) {
                continue
            }
            generatedName.add(member.display_name)

            if (!member.signature.has_value_signature) {
                throw new TypeError(
                    `not a value signature: ${JSON.stringify(member.toObject(), null, 2)}`
                )
            }
            if (member.signature.value_signature.tpe.has_lambda_type) {
                this.reporter.warn(
                    memberSymbol,
                    `ignoring property '${member.display_name}' because it does not serialize correctly to JSON. ` +
                        `To fix this warning, don't expose this lambda type to the protocol`
                )
                // Ignore properties with signatures like
                // `ChatButton.onClick: (action: string) => void`
                continue
            }
            const memberType = member.signature.value_signature.tpe
            if (memberType === undefined) {
                throw new TypeError(`no type: ${JSON.stringify(member.toObject(), null, 2)}`)
            }

            if (f.isIgnoredType(memberType)) {
                continue
            }

            let memberTypeSyntax = f.jsonrpcTypeName(member, memberType, 'parameter')
            const constants = this.stringConstantsFromInfo(member)
            for (const constant of constants) {
                // HACK: merge this duplicate code with the same logic in this file
                this.stringLiteralConstants.add(constant)
            }

            if (constants.length > 0 && memberTypeSyntax.startsWith('String')) {
                const enumTypeName = this.emitter.formatter.formatEnumType(member.display_name)
                memberTypeSyntax = enumTypeName + this.emitter.formatter.nullableSyntax(memberType)
                enums.push({
                    name: enumTypeName,
                    members: constants.map(constant => ({
                        serializedName: constant,
                        formattedName: this.emitter.formatter.formatFieldName(capitalize(constant)),
                    })),
                })
            } else {
                try {
                    this.queueClassLikeType(memberType, member, 'parameter')
                } catch (error) {
                    const stack = error instanceof Error ? '\n' + error.stack : ''
                    const errorMessage = `error handling member: ${member.symbol}. To fix this problem, you may want to ignore it from code generation by adding the symbol name to the "ignoredProperties" in the Formatter.ts file.\n${error}${stack}`
                    this.reporter.error(memberSymbol, errorMessage)
                    continue
                }
            }
            const oneofSyntax = constants.length > 0 ? ' // Oneof: ' + constants.join(', ') : ''
            const fieldName = this.emitter.formatter.formatFieldName(member.display_name)
            members.push({
                info: member,
                typeSyntax: memberTypeSyntax,
                formattedName: fieldName,
                oneOfComment: oneofSyntax,
                isNullable: this.emitter.formatter.isNullable(memberType),
            })
        }
        this.emitter.emitDataClass(p, {
            ...params,
            name,
            info,
            members,
            enums,
        })
    }

    private aliasType(info: scip.SymbolInformation): string | undefined {
        if (info.display_name === 'Date') {
            // Special case for built-in `Date` type because it doesn't
            // serialize to JSON objects with `JSON.stringify()` like it does
            // for other classes.
            return 'String'
        }

        if (this.isStringTypeInfo(info)) {
            const constants = this.stringConstantsFromInfo(info)
            for (const constant of constants) {
                this.stringLiteralConstants.add(constant)
            }
            return `String // One of: ${constants.join(', ')}`
        }

        return undefined
    }

    private async writeType(info: scip.SymbolInformation): Promise<void> {
        const { f, p, c } = this.startDocument()
        const name = f.typeName(info)
        const alias = this.aliasType(info)
        if (f.isIgnoredInfo(info)) {
            return
        }
        this.emitter.startType(p, { name, info })
        if (alias) {
            const isStringType = this.isStringTypeInfo(info)
            let enum_: Enum | undefined
            if (isStringType) {
                const constants = this.stringConstantsFromInfo(info)
                if (constants.length > 0) {
                    enum_ = {
                        name,
                        members: constants.map(name => ({
                            serializedName: name,
                            formattedName: f.formatFieldName(capitalize(name)),
                        })),
                    }
                }
            }
            this.emitter.emitTypeAlias(p, {
                name,
                alias,
                isStringType,
                info,
                enum: enum_,
            })
        } else {
            const discriminatedUnion = this.discriminatedUnions.get(info.symbol)
            if (discriminatedUnion) {
                this.writeSealedClass(c, name, info, discriminatedUnion)
            } else {
                this.writeDataClass(c, name, info)
            }
        }
        this.emitter.closeType(p, { name, info })
        await fspromises.writeFile(
            path.join(this.options.output, this.emitter.getFileNameForType(info.display_name)),
            p.build()
        )
    }

    private async writeProtocolInterface(
        name: string,
        requestSymbol: string,
        notificationSymbol: string
    ): Promise<void> {
        const { f, p, symtab } = this.startDocument()
        const requests: scip.SymbolInformation[] = []
        const notifications: scip.SymbolInformation[] = []

        for (const request of symtab.structuralType(symtab.canonicalSymbol(requestSymbol))) {
            // We skip the webview protocol because our IDE clients are now
            // using the string-encoded protocol instead.
            if (
                request.display_name === 'webview/receiveMessage' ||
                request.display_name === 'chat/submitMessage' ||
                request.display_name === 'chat/editMessage'
            ) {
                continue
            }
            // Process a JSON-RPC request signature. For example:
            // type Requests = { 'textDocument/inlineCompletions': [RequestParams, RequestResult] }
            const resultType = request.signature.value_signature.tpe.type_ref.type_arguments?.[1]
            if (resultType === undefined) {
                this.reporter.error(
                    request.symbol,
                    `missing result type for request. To fix this problem, add a second element to the array type like this: 'example/method: [RequestParams, RequestResult]'`
                )
                continue
            }
            const { parameterType } = f.jsonrpcMethodParameter(request)
            this.queueClassLikeType(parameterType, request, 'parameter')
            this.queueClassLikeType(resultType, request, 'result')
            requests.push(request)
        }

        for (const notification of symtab.structuralType(symtab.canonicalSymbol(notificationSymbol))) {
            // We skip the webview protocol because our IDE clients are now
            // using the string-encoded protocol instead.
            if (notification.display_name === 'webview/postMessage') {
                continue
            }
            // Process a JSON-RPC request signature. For example:
            // type Notifications = { 'textDocument/inlineCompletions': [NotificationParams] }
            const { parameterType } = f.jsonrpcMethodParameter(notification)
            this.queueClassLikeType(parameterType, notification, 'parameter')
            notifications.push(notification)
        }
        this.emitter.emitProtocolInterface(p, { name, requests, notifications })

        await fspromises.writeFile(
            path.join(this.options.output, `${name}.${this.emitter.getFileType()}`),
            p.build()
        )
    }

    // We are referencing the given type in the generated code. If this type
    // references a class-like symbol (example, TypeScript interface), then we
    // should queue the generation of this type.
    private queueClassLikeType(
        type: scip.Type,
        jsonrpcMethod: scip.SymbolInformation,
        kind: 'parameter' | 'result'
    ): void {
        if (type.has_type_ref) {
            if (type.type_ref.symbol === typescriptKeyword('array')) {
                this.queueClassLikeType(type.type_ref.type_arguments[0], jsonrpcMethod, kind)
            } else if (this.emitter.formatter.isRecord(type.type_ref.symbol)) {
                if (type.type_ref.type_arguments.length !== 2) {
                    throw new TypeError(`record must have 2 type arguments: ${this.debug(type)}`)
                }
                this.queueClassLikeType(type.type_ref.type_arguments[0], jsonrpcMethod, kind)
                this.queueClassLikeType(type.type_ref.type_arguments[1], jsonrpcMethod, kind)
            } else if (typescriptKeywordSyntax(type.type_ref.symbol)) {
                // Typescript keywords map to primitive types (Int, Double) or built-in types like String
            } else {
                this.queueClassLikeInfo(this.symtab.info(type.type_ref.symbol))
            }
            return
        }

        if (type.has_structural_type || type.has_intersection_type) {
            // Generate new (nominal) type for this anonymous
            // structural/intersection type. For example, consider the property
            // `foo` in `interface Foo { foo: A & B }` or `foo: { a: b, c: d}`,
            // we create a new type with the name `FooParams` that contains the
            // aggregate properties of `A & B` or `{a: b, c: d}`.
            this.queueClassLikeInfo(
                new scip.SymbolInformation({
                    display_name: this.emitter.formatter.jsonrpcTypeName(jsonrpcMethod, type, kind),
                    // Need unique symbol for parameter+result types
                    symbol: `${jsonrpcMethod.symbol}(${kind}).`,
                    signature: new scip.Signature({
                        // Convert structural types to class signature with name of the JSON-RPC method
                        class_signature: new scip.ClassSignature({
                            declarations: new scip.Scope({ symlinks: this.properties(type) }),
                        }),
                    }),
                })
            )
            return
        }

        if (type.has_union_type && type.union_type.types.every(type => type.has_constant_type)) {
            // No need need to come up with a nominal type for unions of string
            // contants, like `foo: 'a' | 'b'`.
            return
        }

        if (type.has_union_type) {
            const nonNullableTypes = type.union_type.types.filter(
                type => !this.emitter.formatter.isNullable(type)
            )
            if (
                nonNullableTypes.every(
                    tpe => tpe.has_type_ref && isTypescriptKeyword(tpe.type_ref.symbol)
                )
            ) {
                // Nothing to queue
                return
            }
            if (nonNullableTypes.length === 1) {
                // Ignore `| null` union types and just queue the non-null type.
                // All properties in the generated bindings are nullable by
                // defaults anyways, even if the original type is not nullable.
                this.queueClassLikeType(nonNullableTypes[0], jsonrpcMethod, kind)
            } else {
                // Used hardcoded list of exceptions for how to resolve union
                // types. In some cases, we are exposing VS Code  APIs that have
                // unions like `string | MarkdownString` where we just assume
                // the type will always be `string`.
                const exceptionIndex = this.emitter.formatter.unionTypeExceptionIndex.find(
                    ({ prefix }) => jsonrpcMethod.symbol.startsWith(prefix)
                )?.index
                if (exceptionIndex !== undefined) {
                    this.reporter.warn(
                        jsonrpcMethod.symbol,
                        `resolving unsupported union by picking type ${exceptionIndex}. ${this.debug(
                            jsonrpcMethod
                        )}`
                    )
                    this.queueClassLikeType(nonNullableTypes[exceptionIndex], jsonrpcMethod, kind)
                } else {
                    throw new Error(
                        `unsupported union type: ${JSON.stringify(jsonrpcMethod.toObject(), null, 2)}`
                    )
                }
            }
            return
        }

        if (type.has_constant_type) {
            return
        }

        throw new Error(`unsupported type: ${this.debug(type)}`)
    }

    private unionTypes(type: scip.Type): scip.Type[] {
        const result: scip.Type[] = []
        const loop = (t: scip.Type): void => {
            if (t.has_union_type) {
                for (const unionType of t.union_type.types) {
                    if (unionType.has_type_ref) {
                        const info = this.symtab.info(unionType.type_ref.symbol)
                        if (
                            info.signature.has_type_signature &&
                            info.signature.type_signature.lower_bound.has_union_type
                        ) {
                            loop(info.signature.type_signature.lower_bound)
                            continue
                        }
                    }
                    result.push(unionType)
                }
            }
        }
        loop(type)
        return result
    }

    private discriminatedUnion(info: scip.SymbolInformation): DiscriminatedUnion | undefined {
        if (!info.signature.has_type_signature) {
            return undefined
        }
        const type = info.signature.type_signature.lower_bound
        if (!type.has_union_type || type.union_type.types.length === 0) {
            return undefined
        }
        const candidates = new Map<string, number>()
        const memberss = new Map<string, DiscriminatedUnionMember[]>()
        const unionTypes = this.unionTypes(type)
        for (const unionType of unionTypes) {
            for (const propertySymbol of this.properties(unionType)) {
                const property = this.symtab.info(propertySymbol)
                const stringLiteral = stringLiteralType(property.signature.value_signature.tpe)
                if (!stringLiteral) {
                    continue
                }
                const count = candidates.get(property.display_name) ?? 0
                candidates.set(property.display_name, count + 1)
                let members = memberss.get(property.display_name)
                if (!members) {
                    members = []
                    memberss.set(property.display_name, members)
                }
                members.push({ value: stringLiteral, type: unionType })
            }
        }
        for (const [candidate, count] of candidates.entries()) {
            if (count === unionTypes.length) {
                return {
                    symbol: info.symbol,
                    discriminatorDisplayName: candidate,
                    members: memberss.get(candidate) ?? [],
                }
            }
        }
        return undefined
    }

    // Same as `queueClassLikeType` but for `scip.SymbolInformation` instead of `scip.Type`.
    private queueClassLikeInfo(jsonrpcMethod: scip.SymbolInformation): void {
        if (!jsonrpcMethod.has_signature) {
            return
        }
        if (jsonrpcMethod.signature.has_class_signature) {
            // Easy, this looks like a class/interface.
            this.queue.push(jsonrpcMethod)
            return
        }

        if (this.isStringTypeInfo(jsonrpcMethod)) {
            // Easy, we can create a string type alias
            this.queue.push(jsonrpcMethod)
            return
        }

        const discriminatedUnion = this.isNestedDiscriminatedUnion
            ? this.discriminatedUnion(jsonrpcMethod)
            : undefined
        if (discriminatedUnion) {
            this.discriminatedUnions.set(jsonrpcMethod.symbol, discriminatedUnion)
            this.queue.push(jsonrpcMethod)
            return
        }

        if (jsonrpcMethod.signature.has_type_signature) {
            // Tricky case, creatively convert this type alias into a class signature. This is tricky because
            // a type alias can have all sorts of shapes. For example,
            //   type Foo1 = A & B
            //   type Foo2 = { kind: 'a' } | {kind: 'b'}
            //   type Foo3 = ({ kind: 'a' } & A) | ({kind: 'b'} & B)
            //  The logic below does a best-effort to convert any shape into a
            //  basic data class (aka. struct). Simplified, we collect all the transitive properties of the referenced
            // types and create a class with all those properties while ensuring that no two properties have the same
            // name but incompatible type signatures. For example, there's no straighforward translation for the
            // following case because `member` has the type `string | number`:
            //   type ExtensionMessage =
            //      { kind: 'a', member: string } |
            //      { kind: 'a', member: number }
            //  When encountering these cases, we report an error message.

            const declarations = new Map<
                string,
                { info: scip.SymbolInformation; diagnostic: Diagnostic; siblings: string[] }
            >()
            for (const property of this.properties(jsonrpcMethod.signature.type_signature.lower_bound)) {
                const propertyInfo = this.symtab.info(property)
                const sibling = declarations.get(propertyInfo.display_name)
                if (!sibling) {
                    declarations.set(propertyInfo.display_name, {
                        info: propertyInfo,
                        diagnostic: {
                            severity: Severity.Error,
                            symbol: property,
                            message: dedent`Incompatible signatures. For discriminated unions, each property name must map to a unique type.
                                   For example, it's not allowed to have a property named 'result', which is a string for one type in the
                                   discrimated union and a number for another type in the union. To fix this problem, give one of the
                                   following properties a unique name and try running the code generator again.`,
                            additionalInformation: [],
                        },
                        siblings: [],
                    })
                    continue
                }
                const { info: siblingProperty, diagnostic, siblings } = sibling

                if (!this.compatibleSignatures(siblingProperty, propertyInfo)) {
                    diagnostic.additionalInformation?.push({
                        severity: Severity.Error,
                        symbol: property,
                        message: 'conflict here',
                    })
                } else {
                    siblings.push(property)
                }
            }

            if (declarations.size > 0) {
                for (const { info, diagnostic, siblings } of declarations.values()) {
                    this.siblingDiscriminatedUnionProperties.set(info.symbol, siblings)
                    if (
                        diagnostic.additionalInformation &&
                        diagnostic.additionalInformation.length > 0
                    ) {
                        this.reporter.report(diagnostic)
                    }
                }

                this.queue.push(
                    new scip.SymbolInformation({
                        display_name: jsonrpcMethod.display_name,
                        symbol: jsonrpcMethod.symbol,
                        signature: new scip.Signature({
                            class_signature: new scip.ClassSignature({
                                declarations: new scip.Scope({
                                    symlinks: [...declarations.values()].map(({ info }) => info.symbol),
                                }),
                            }),
                        }),
                    })
                )
            } else {
                this.reporter.warn(jsonrpcMethod.symbol, 'no properties found for this type')
            }
            return
        }

        throw new TypeError(`unknown info: ${JSON.stringify(jsonrpcMethod.toObject(), null, 2)}`)
    }
}
