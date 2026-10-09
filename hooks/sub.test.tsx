import { expect, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'sub-discuss',
  component: 'Pane',
  requestId: 'sub-discuss',
  props: {
    title: '子對話',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

for (const surface of SURFACES) {
  test(`asks, follows up and sends a confirmed summary back (${surface})`, async ($, on) => {
    const forks: string[] = []
    const appended: string[] = []
    on('model.fork', ($, e) => {
      forks.push(e.prompt)
      const text = e.prompt.startsWith('[子對話回傳]') ? '摘要：X 是 Y' : `回答 ${forks.length}`
      return { value: { isAnswered: true, text, usage: USAGE } }
    })
    on('session.append', ($, e, next) => {
      const block = e.message.content[0]
      appended.push(`${e.message.type}:${block && 'text' in block ? block.text : ''}`)
      return next(e)
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }))

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'start-0', text: 'X 是什麼？' })

    expect((await ui.find({ type: 'Markdown', text: /回答 1/ })) !== undefined).toBe(true)
    expect(forks[0]).toContain('X 是什麼？')

    await ui.input({ key: 'ask-1-1', text: '再舉個例子' })
    expect((await ui.find({ type: 'Markdown', text: /回答 2/ })) !== undefined).toBe(true)
    // The follow-up carries the sub-thread so far.
    expect(forks[1]).toContain('回答 1')

    await ui.press({ key: 'merge' })
    expect((await ui.find({ type: 'Markdown', text: /摘要：X 是 Y/ })) !== undefined).toBe(true)
    expect(appended).toHaveLength(0)

    await ui.press({ key: 'send' })
    expect(appended[0]).toContain('user:〔子對話 #1')
    expect(appended[0]).toContain('摘要：X 是 Y')
    expect(appended[1]).toContain('system:')
    expect((await ui.find({ text: /以上已回傳主對話/ })) !== undefined).toBe(true)
  })
}

test('/sub with a question opens a thread', async ($, on) => {
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const result = await $.command.run({
    command: 'sub',
    args: '什麼是 monad？',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(result.text).toContain('子對話 #1')
})
