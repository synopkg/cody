import * as vscode from 'vscode'

import type {
    ClientConfiguration,
    CompletionLogger,
    SourcegraphCompletionsClient,
} from '@sourcegraph/cody-shared'
import type { startTokenReceiver } from './auth/token-receiver'
import { onActivationDevelopmentHelpers } from './dev/helpers'

import './editor/displayPathEnvInfo' // import for side effects

import type { createController } from '@openctx/vscode-lib'
import type { CommandsProvider } from './commands/services/provider'
import { ExtensionApi } from './extension-api'
import type { ExtensionClient } from './extension-client'
import type { SymfRunner } from './local-context/symf'
import { start } from './main'
import type { OpenTelemetryService } from './services/open-telemetry/OpenTelemetryService.node'
import { type SentryService, captureException } from './services/sentry/sentry'

type Constructor<T extends new (...args: any) => any> = T extends new (
    ...args: infer A
) => infer R
    ? (...args: A) => R
    : never

export interface PlatformContext {
    intializeConfigurationProxy?: () => Promise<void>
    createOpenCtxController?: typeof createController
    createStorage?: () => Promise<vscode.Memento>
    createCommandsProvider?: Constructor<typeof CommandsProvider>
    createSymfRunner?: Constructor<typeof SymfRunner>
    createCompletionsClient: (logger?: CompletionLogger) => SourcegraphCompletionsClient
    createSentryService?: () => SentryService
    createOpenTelemetryService?: () => OpenTelemetryService
    startTokenReceiver?: typeof startTokenReceiver
    otherInitialization?: () => vscode.Disposable
    extensionClient: ExtensionClient
}

export async function activate(
    context: vscode.ExtensionContext,
    platformContext: PlatformContext
): Promise<ExtensionApi> {
    const api = new ExtensionApi(context.extensionMode)
    try {
        const disposable = await start(context, platformContext)
        if (!context.globalState.get('extension.hasActivatedPreviously')) {
            void context.globalState.update('extension.hasActivatedPreviously', 'true')
        }
        context.subscriptions.push(disposable)

        if (context.extensionMode === vscode.ExtensionMode.Development) {
            onActivationDevelopmentHelpers()
        }
    } catch (error) {
        captureException(error)
        console.error(error)
    }
    return api
}
