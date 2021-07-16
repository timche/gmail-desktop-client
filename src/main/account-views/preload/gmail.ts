import { ipcRenderer, IpcRendererEvent } from 'electron'
import elementReady from 'element-ready'
import { gmailUrl } from '../../../constants'
import { Mail } from '../../../types'
import {
  domParser,
  getContentBySelector,
  getDateBySelector,
  getNumberBySelector
} from '../../utils/dom'

declare global {
  interface Window {
    GM_INBOX_TYPE: 'CLASSIC' | 'SECTIONED'
  }
}

const mailActions = {
  archive: 'rc_^i',
  markAsRead: 'rd',
  delete: 'tr',
  markAsSpam: 'sp'
}

const inboxElementSelector = 'div[role=navigation] a[href*="#inbox"]'

let actionToken: string | undefined
let inboxParentElement: Element | undefined
let previousUnreadCount: number | undefined
let isInitialNewMailsFetch = true
let feedVersion = 0
let previousModifiedFeedDate = 0
let currentModifiedFeedDate = 0
let previousNewMails = new Set<string>()
let unreadCountObserver: MutationObserver

async function gmailRequest(
  path = '',
  fetchOptions?: Parameters<typeof fetch>[1]
) {
  return fetch(`${gmailUrl}${path}`, fetchOptions)
}

async function observeUnreadInbox() {
  await findInboxParentElement()

  if (inboxParentElement) {
    getUnreadInbox()
    const observer = new MutationObserver(() => {
      getUnreadInbox()
    })
    observer.observe(inboxParentElement, { childList: true })
  }
}

async function fetchNewMails(sendUnreadCount?: boolean) {
  const isInboxSectioned = window.GM_INBOX_TYPE === 'SECTIONED'
  const label = isInboxSectioned ? '/^sq_ig_i_personal' : ''
  const version = ++feedVersion

  const feedDocument = await gmailRequest(`feed/atom${label}?v=${version}`)
    .then(async (response) => response.text())
    .then((xml) => domParser.parseFromString(xml, 'text/xml'))

  previousModifiedFeedDate = currentModifiedFeedDate
  currentModifiedFeedDate = getDateBySelector(feedDocument, 'modified')

  const isFeedModified = previousModifiedFeedDate !== currentModifiedFeedDate

  if (!isFeedModified) {
    return
  }

  if (sendUnreadCount) {
    const unreadCount = getNumberBySelector(feedDocument, 'fullcount')
    ipcRenderer.send('gmail:unread-count', unreadCount)
  }

  const newMails = parseNewMails(feedDocument)

  // Don't notify about new mails on first start
  if (isInitialNewMailsFetch) {
    isInitialNewMailsFetch = false
  } else {
    ipcRenderer.send('gmail:new-mails', newMails)
  }
}

async function sendMailAction(
  mailId: string,
  action: keyof typeof mailActions
) {
  await fetchActionToken()

  if (!actionToken) {
    throw new Error('Action token is missing')
  }

  const parameters = new URLSearchParams({
    t: mailId,
    at: actionToken,
    act: mailActions[action]
  }).toString()

  return gmailRequest(`?${parameters}`)
}

async function fetchActionToken() {
  if (!actionToken) {
    const gmailDocument = await gmailRequest().then(async (response) =>
      response.text()
    )

    actionToken = /var GM_ACTION_TOKEN="([\w-]+)";/.exec(gmailDocument)?.[1]
  }
}

function refreshInbox() {
  if (window.location.hash.startsWith('#inbox')) {
    const inboxElement = getInboxElement()
    if (inboxElement) {
      inboxElement.click()
    }
  }
}

async function findInboxParentElement() {
  const inboxElement = await elementReady(inboxElementSelector, {
    stopOnDomReady: false,
    timeout: 60000
  })

  inboxParentElement =
    inboxElement?.parentElement?.parentElement?.parentElement?.parentElement
      ?.parentElement?.parentElement ?? undefined
}

function getInboxElement() {
  return (
    document.querySelector<HTMLAnchorElement>(inboxElementSelector) ?? undefined
  )
}

function getUnreadInbox() {
  const inboxElement = getInboxElement()

  if (!inboxElement) {
    return
  }

  const unreadCountElement =
    inboxElement.parentElement?.parentElement?.querySelector('.bsU') ??
    undefined

  const currentUnreadCount = unreadCountElement?.textContent
    ? Number(unreadCountElement.textContent)
    : 0

  if (previousUnreadCount !== currentUnreadCount) {
    ipcRenderer.send('gmail:unread-count', currentUnreadCount)
    fetchNewMails()
    previousUnreadCount = currentUnreadCount
  }
}

function parseNewMails(feedDocument: Document) {
  const newMails: Mail[] = []
  const mails = feedDocument.querySelectorAll('entry')
  const currentDate = Date.now()

  for (const mail of mails) {
    const link = mail.querySelector('link')!.getAttribute('href')!
    const messageId = new URLSearchParams(link).get('message_id')!

    if (previousNewMails.has(messageId)) {
      continue
    }

    const issuedDate = getDateBySelector(mail, 'issued')

    if (currentDate - issuedDate < 60000) {
      previousNewMails.add(messageId)

      const newMail = {
        messageId,
        link,
        subject: getContentBySelector(mail, 'title'),
        summary: getContentBySelector(mail, 'summary').trim(),
        sender: {
          name: getContentBySelector(mail, 'name'),
          email: getContentBySelector(mail, 'email')
        }
      }

      newMails.push(newMail)
    }
  }

  return newMails
}

const nextTick = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

async function composeMail(
  _event: IpcRendererEvent,
  to?: string,
  cc?: string | null,
  bcc?: string | null,
  subject?: string | null,
  body?: string | null
) {
  // Can't use element ids as selectors since they aren't stable

  const composeButton = await elementReady<HTMLDivElement>('div[gh="cm"]', {
    stopOnDomReady: false,
    timeout: 60000
  })
  if (!composeButton) throw new Error('No composeButton')
  composeButton.click()

  // Out of the "to" block because we use the readiness of this element to
  // know when we can start filling out the fields
  const toElement = await elementReady<HTMLTextAreaElement>(
    'textarea[name="to"]',
    {
      stopOnDomReady: false,
      timeout: 60000
    }
  )
  const ccElement = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="cc"]'
  )
  const bccElement = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="bcc"]'
  )
  const subjectElement = document.querySelector<HTMLInputElement>(
    'input[name="subjectbox"]'
  )
  const bodyElement = document.querySelector<HTMLDivElement>(
    'div[aria-label="Message Body"]'
  )

  if (!toElement) throw new Error('No toElement')
  if (!ccElement) throw new Error('No ccElement')
  if (!bccElement) throw new Error('No bccElement')
  if (!subjectElement) throw new Error('No subjectElement')
  if (!bodyElement) throw new Error('No bodyElement')

  if (to) {
    toElement.focus()
    toElement.value = to
    await nextTick()
  }

  // Why the nextTick at the end of each block? Because otherwise the
  // fields that follow may fail to get focused for some reason. This
  // isn't the original comment, see prior commits.

  if (cc) {
    document
      .querySelector<HTMLSpanElement>(
        'span[aria-label="Add Cc recipients ‪(Ctrl-Shift-C)‬"]'
      )
      ?.click()
    ccElement.focus()
    ccElement.value = cc
    await nextTick()
  }

  if (bcc) {
    document
      .querySelector<HTMLSpanElement>(
        'span[aria-label="Add Bcc recipients ‪(Ctrl-Shift-B)‬"]'
      )
      ?.click()
    bccElement.focus()
    bccElement.value = bcc
    await nextTick()
  }

  if (subject) {
    subjectElement.focus()
    subjectElement.value = subject
    await nextTick()
  }

  if (body) {
    bodyElement.focus()
    bodyElement.innerHTML = body
    await nextTick()
  }

  /* eslint-disable no-negated-condition */
  if (!to) {
    toElement.focus()
  } else if (!subject) {
    subjectElement.focus()
  } else {
    bodyElement.focus()
  }
  /* eslint-enable no-negated-condition */
}

export function initGmail() {
  window.addEventListener('DOMContentLoaded', () => {
    observeUnreadInbox()

    ipcRenderer.on('gmail:archive-mail', async (_event, mailId: string) => {
      await sendMailAction(mailId, 'archive')
      refreshInbox()
    })

    ipcRenderer.on('gmail:mark-as-read', async (_event, mailId: string) => {
      await sendMailAction(mailId, 'markAsRead')
      refreshInbox()
    })

    ipcRenderer.on('gmail:delete-mail', async (_event, mailId: string) => {
      await sendMailAction(mailId, 'delete')
      refreshInbox()
    })

    ipcRenderer.on('gmail:mark-as-spam', async (_event, mailId: string) => {
      await sendMailAction(mailId, 'markAsSpam')
      refreshInbox()
    })

    ipcRenderer.on('gmail:go-to', (_event, destination: string) => {
      switch (destination) {
        case 'inbox':
        case 'starred':
        case 'snoozed':
        case 'sent':
        case 'drafts':
        case 'imp':
        case 'scheduled':
        case 'all':
        case 'settings':
          window.location.hash = `#${destination}`
          break
        default:
      }
    })

    ipcRenderer.on(
      'gmail:open-mail',
      (_event: IpcRendererEvent, messageId: string) => {
        window.location.hash = `#inbox/${messageId}`
      }
    )

    ipcRenderer.on('gmail:compose-mail', composeMail)

    ipcRenderer.send('gmail:ready')

    setInterval(() => {
      previousNewMails.clear()
    }, 1000 * 60 * 30)
  })

  window.addEventListener('unload', () => {
    unreadCountObserver.disconnect()

    actionToken = undefined
    inboxParentElement = undefined
    previousUnreadCount = undefined
    isInitialNewMailsFetch = true
    feedVersion = 0
    previousModifiedFeedDate = 0
    currentModifiedFeedDate = 0
    previousNewMails = new Set()
  })
}
