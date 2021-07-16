import { sendToSelectedAccountView } from './account-views'
import { instanceOfNodeError } from '../utils/type-helpers'

function parse(uri: string) {
  try {
    return new URL(uri)
  } catch (error: unknown) {
    if (
      instanceOfNodeError(error, TypeError) &&
      error.code === 'ERR_INVALID_URL'
    ) {
      return
    }

    throw error
  }
}

const spaceAfterComma = (x: string | null) => x?.replaceAll(',', ', ')

export function handleMailto(uri?: string) {
  if (!uri) return // Empty string doesn't cut it either
  const x = parse(uri)
  if (!x) return
  sendToSelectedAccountView(
    'gmail:compose-mail',
    spaceAfterComma(x.pathname),
    spaceAfterComma(x.searchParams.get('cc')),
    spaceAfterComma(x.searchParams.get('bcc')),
    x.searchParams.get('subject'),
    x.searchParams.get('body')
  )
}
