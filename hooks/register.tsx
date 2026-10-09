import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SubThread } from '../types'

const PANE = 'sub-discuss'
const threads = atom({ plugin: 'sub-discuss', key: 'threads' } as const, [])
const activeId = atom({ plugin: 'sub-discuss', key: 'activeId' } as const, null)
// Bumped after each question so the Input is drawn afresh, empty.
const inputSeq = atom({ plugin: 'sub-discuss', key: 'inputSeq' } as const, 0)

const transcript = (thread: SubThread, from = 0) =>
  thread.messages
    .slice(from)
    .map(m => `${m.role === 'user' ? '使用者' : '你'}：${m.text}`)
    .join('\n\n')

const askPrompt = (thread: SubThread, question: string) =>
  [
    '[子對話模式] 使用者在主對話旁開了一個側邊子對話。這裡的問答不會進入主對話，',
    '請只回答子對話的問題，不要延續主對話正在進行的任務，也不要呼叫工具。',
    '用使用者的語言回答，清楚精簡；需要時引用主對話中的相關內容。',
    '',
    `子對話主題：${thread.title}`,
    thread.messages.length > 0 ? `\n--- 子對話到目前為止 ---\n${transcript(thread)}` : '',
    '',
    '--- 新的問題 ---',
    question,
  ].join('\n')

const mergePrompt = (thread: SubThread) =>
  [
    '[子對話回傳] 以下是使用者在側邊子對話中的討論。請寫一則要送回主對話的「回傳摘要」，',
    '讓主對話之後能直接使用。格式：',
    '1. 結論重點（條列）',
    '2. 若子對話的結論修正、補充或推翻了主對話先前的內容，明確指出是哪一段說法，以及新的說法',
    '3. 對主對話接下來工作的影響或建議（沒有就省略）',
    '只輸出摘要本身，不要前言，不要呼叫工具。',
    thread.mergedUpTo > 0
      ? `\n前 ${thread.mergedUpTo} 則訊息已經回傳過，只摘要之後新增的部分（前面的內容僅供參考）。`
      : '',
    '',
    `子對話主題：${thread.title}`,
    '--- 子對話內容 ---',
    transcript(thread),
  ].join('\n')

const titleOf = (question: string) => {
  const line = question.trim().split('\n')[0] ?? ''
  return line.length > 24 ? `${line.slice(0, 24)}…` : line
}

const patch = ($: EngineInterface, id: number, fn: (t: SubThread) => SubThread) =>
  update($, threads, list => list.map(t => (t.id === id ? fn(t) : t)))

const find = async ($: EngineInterface, id: number) =>
  (await read($, threads)).find(t => t.id === id)

const failure = (reason: string) => `（沒有取得回覆：${reason}）`

async function startThread($: EngineInterface, question: string) {
  const list = await read($, threads)
  const id = list.reduce((max, t) => Math.max(max, t.id), 0) + 1
  const thread: SubThread = {
    id,
    title: titleOf(question),
    messages: [],
    isOpen: true,
    isThinking: false,
    draft: null,
    isDrafting: false,
    mergedUpTo: 0,
  }
  await update($, threads, all => [...all, thread])
  await update($, activeId, () => id)

  return id
}

async function ask($: EngineInterface, id: number, question: string) {
  const thread = await find($, id)
  if (!thread || thread.isThinking) {
    return
  }
  const prompt = askPrompt(thread, question)
  await patch($, id, t => ({
    ...t,
    messages: [...t.messages, { role: 'user', text: question }],
    isThinking: true,
  }))
  await update($, inputSeq, n => n + 1)

  let text: string
  try {
    const reply = await $.model.fork({ prompt })
    text = reply.isAnswered ? reply.text : failure(reply.reason)
  } catch (err) {
    // A refused request (a blocked model) rejects instead of answering.
    text = failure(err instanceof Error ? err.message : String(err))
  }
  await patch($, id, t => ({
    ...t,
    messages: [...t.messages, { role: 'assistant', text }],
    isThinking: false,
  }))
}

async function draftMerge($: EngineInterface, id: number) {
  const thread = await find($, id)
  if (!thread || thread.isDrafting || thread.messages.length === 0) {
    return
  }
  await patch($, id, t => ({ ...t, isDrafting: true, draft: null }))
  let draft: string | null = null
  let problem = ''
  try {
    const reply = await $.model.fork({ prompt: mergePrompt(thread) })
    if (reply.isAnswered) {
      draft = reply.text
    } else {
      problem = reply.reason
    }
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
  }
  await patch($, id, t => ({ ...t, isDrafting: false, draft }))
  if (problem) {
    $.ui.toast(failure(problem))
  }
}

async function sendMerge($: EngineInterface, id: number, close: boolean) {
  const thread = await find($, id)
  if (!thread?.draft) {
    return
  }
  const note = [
    `〔子對話 #${thread.id}「${thread.title}」回傳〕`,
    '（這是使用者在側邊子對話中討論後確認的結論。若與前文衝突，以此為準。）',
    '',
    thread.draft,
  ].join('\n')

  const stored = await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: note }] },
  })
  if (stored.deny) {
    $.ui.toast(`回傳被拒絕：${stored.deny}`)
    return
  }
  await $.session.append({
    message: {
      type: 'system',
      content: [{ type: 'text', text: `子對話 #${thread.id}「${thread.title}」的結論已送回主對話` }],
    },
  })
  await patch($, id, t => ({
    ...t,
    draft: null,
    mergedUpTo: t.messages.length,
    isOpen: close ? false : t.isOpen,
  }))
  if (close) {
    await closeThread($, id)
  }
  $.ui.toast(`子對話 #${thread.id} 已回傳主對話`)
}

async function closeThread($: EngineInterface, id: number) {
  await patch($, id, t => ({ ...t, isOpen: false, draft: null }))
  const next = (await read($, threads)).filter(t => t.isOpen).at(-1)
  await update($, activeId, () => next?.id ?? null)
}

const openPane = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: '子對話', focus: true })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sub',
      description: '開一個子對話（側邊討論）；不帶參數則打開子對話面板',
      argumentHint: '<想展開的問題>',
    })

    return next(e)
  })

  on('command.run', { command: 'sub' }, async ($, e) => {
    const question = e.args.trim()
    if (!question) {
      await openPane($)
      return { text: '已打開子對話面板。' }
    }
    const id = await startThread($, question)
    await openPane($)
    // Not awaited: the command returns at once and the answer fills the pane.
    // The module reloading under it is the one way this rejects; nothing to tell.
    ask($, id, question).catch(() => undefined)

    return { text: `已開啟子對話 #${id}：${titleOf(question)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    // The mobile surface has no text field: it can read and press, not type.
    const Input = 'Input' in elements ? elements.Input : null
    const noInput = <Text dimColor>這個介面無法輸入，請在終端機或桌面版提問。</Text>
    const all = await read($, threads)
    const open = all.filter(t => t.isOpen)
    const active = await read($, activeId)
    const current = open.find(t => t.id === active)
    const seq = await read($, inputSeq)

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {open.map(t => (
          <Button
            key={`tab-${t.id}`}
            label={`#${t.id} ${t.title}${t.isThinking || t.isDrafting ? ' …' : ''}`}
            variant={t.id === current?.id ? 'primary' : 'secondary'}
            onPress={() => update($, activeId, () => t.id)}
          />
        ))}
        <Button key="new" label="＋ 新子對話" onPress={() => update($, activeId, () => null)} />
      </Box>
    )

    if (!current) {
      return (
        <Box flexDirection="column" gap={1}>
          {open.length > 0 && tabs}
          <Text dimColor>輸入想展開的問題，開一個新的子對話。主對話會照常進行。</Text>
          {Input ? (
            <Input
              key={`start-${seq}`}
              label="新子對話"
              placeholder="例如：剛剛提到的 X 是什麼意思？"
              submitLabel="開始"
              autoFocus
              onSubmit={async (value: string) => {
                const question = value.trim()
                if (question) {
                  await ask($, await startThread($, question), question)
                }
              }}
            />
          ) : (
            noInput
          )}
        </Box>
      )
    }

    const isBusy = current.isThinking || current.isDrafting
    const unmerged = current.messages.length - current.mergedUpTo

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box flexDirection="column" gap={1}>
          {current.messages.map((m, i) => (
            <Box key={`m-${i}`} flexDirection="column">
              {m.role === 'user' ? <Text bold>你：{m.text}</Text> : <Markdown text={m.text} />}
              {i + 1 === current.mergedUpTo && <Text dimColor>── 以上已回傳主對話 ──</Text>}
            </Box>
          ))}
          {current.isThinking && <Text dimColor>思考中…</Text>}
        </Box>

        {current.isDrafting && <Text dimColor>正在整理回傳摘要…</Text>}
        {current.draft !== null && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>回傳摘要（確認後才會送進主對話）</Text>
            <Markdown key="draft" text={current.draft} />
            <Box flexDirection="row" columnGap={1}>
              <Button
                key="send"
                label="送出"
                variant="primary"
                onPress={() => sendMerge($, current.id, false)}
              />
              <Button
                key="send-close"
                label="送出並結束"
                onPress={() => sendMerge($, current.id, true)}
              />
              <Button key="redo" label="重新產生" onPress={() => draftMerge($, current.id)} />
              <Button
                key="discard"
                label="捨棄"
                role="dismiss"
                onPress={() => patch($, current.id, t => ({ ...t, draft: null }))}
              />
            </Box>
          </Box>
        )}

        {Input ? (
          <Input
            key={`ask-${current.id}-${seq}`}
            label="追問"
            placeholder={isBusy ? '等待回覆中…' : '繼續在子對話裡問…'}
            submitLabel="送出"
            autoFocus
            onSubmit={(value: string) => {
              const question = value.trim()
              return question ? ask($, current.id, question) : undefined
            }}
          />
        ) : (
          noInput
        )}
        <Box flexDirection="row" columnGap={1}>
          <Button
            key="merge"
            label={unmerged > 0 ? '整理回傳摘要' : '沒有新內容可回傳'}
            dimColor={unmerged <= 0 || isBusy}
            onPress={() => (unmerged > 0 && !isBusy ? draftMerge($, current.id) : undefined)}
          />
          <Button key="close" label="結束子對話" onPress={() => closeThread($, current.id)} />
        </Box>
      </Box>
    )
  })
}
