export type SubMessage = { role: 'user' | 'assistant'; text: string }

export type SubThread = {
  id: number
  title: string
  messages: SubMessage[]
  isOpen: boolean
  isThinking: boolean
  // A merge summary waiting for the person to send, edit away or discard.
  draft: string | null
  isDrafting: boolean
  // How many messages were already summarized into the main conversation.
  mergedUpTo: number
}

declare module 'claude-code' {
  interface PluginState {
    'sub-discuss': {
      threads: SubThread[]
      activeId: number | null
      inputSeq: number
    }
  }
}
