declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

const globalWithApi = globalThis as { acquireVsCodeApi?: typeof acquireVsCodeApi }
export const isVsCodeHost = typeof globalWithApi.acquireVsCodeApi === 'function'

const noOpApi = {
  postMessage(_msg: unknown): void {
  },
}

export const vscode = typeof globalWithApi.acquireVsCodeApi === 'function'
  ? globalWithApi.acquireVsCodeApi()
  : noOpApi
