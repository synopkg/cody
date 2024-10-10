import { URI } from 'vscode-uri'

import { type GenericVSCodeWrapper, hydrateAfterPostMessage } from '@sourcegraph/cody-shared'

import type { ExtensionMessage, WebviewMessage } from '../../src/chat/protocol'

declare const acquireVsCodeApi: () => VSCodeApi

interface VSCodeApi {
    getState: () => unknown
    setState: (newState: unknown) => unknown
    postMessage: (message: unknown) => void
}

export type VSCodeWrapper = GenericVSCodeWrapper<WebviewMessage, ExtensionMessage>

let api: VSCodeWrapper

const pigs: { [key: string]: number } = {}

export function getVSCodeAPI(): VSCodeWrapper {
    if (!api) {
        const vsCodeApi = acquireVsCodeApi()
        api = {
            postMessage: message => vsCodeApi.postMessage(message),
            onMessage: callback => {
                const here = new Error().stack || '???'
                pigs[here] = 1 + (pigs[here] || 0)
                const [sum, max, maxCount] = Object.entries(pigs).reduce(
                    ([sum, max, maxCount], [name, count]) => {
                        return [sum + count, count > maxCount ? name : max, Math.max(count, maxCount)]
                    },
                    [0, 'none', 0]
                )
                console.log('onmessage pigs:', sum, maxCount / sum, max)
                const listener = (event: MessageEvent<ExtensionMessage>): void => {
                    console.log(
                        'onmessage (webviews/utils):',
                        JSON.stringify(event.data).slice(0, 120),
                        Object.keys(event.data).sort().join(',')
                    )
                    callback(hydrateAfterPostMessage(event.data, uri => URI.from(uri as any)))
                }
                window.addEventListener('message', listener)
                return () => {
                    window.removeEventListener('message', listener)
                    pigs[here] = (pigs[here] || 1) - 1
                }
            },
            setState: newState => vsCodeApi.setState(newState),
            getState: () => vsCodeApi.getState(),
        }
    }
    return api
}

export function setVSCodeWrapper(value: VSCodeWrapper): void {
    api = value
}

let genericApi: GenericVSCodeWrapper<any, any>

export function getGenericVSCodeAPI<W, E>(): GenericVSCodeWrapper<W, E> {
    if (!genericApi) {
        const vsCodeApi = acquireVsCodeApi()
        genericApi = {
            postMessage: (message: W) => vsCodeApi.postMessage(message),
            onMessage: callback => {
                const listener = (event: MessageEvent<E>): void => {
                    console.log(
                        'onmessage (generic/minion):',
                        JSON.stringify(event.data).slice(0, 120),
                        Object.keys(event).sort().join(',')
                    )
                    callback(hydrateAfterPostMessage(event.data, uri => URI.from(uri as any)))
                }
                window.addEventListener('message', listener)
                return () => window.removeEventListener('message', listener)
            },
            setState: newState => vsCodeApi.setState(newState),
            getState: () => vsCodeApi.getState(),
        }
    }
    return genericApi
}
