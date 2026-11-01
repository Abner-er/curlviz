/**
 * @curlviz/core 对外入口。
 *
 * Web 端与（未来的）Node agent 都只从这里取，Kotlin 侧按同名语义实现。
 * 刻意不依赖浏览器 / Node API，保证一份代码两端 usable。
 */

export * from './types'
export { tokenize, tokenizeWords, type Token, type TokenizeResult, type QuoteKind } from './tokenizer'
export {
  parseCurl,
  suggestName,
  splitFormPairs,
  parseMultipartArg,
  looksLikeJson,
  isFormUrlencoded,
  base64ToBytes,
  bytesToBase64
} from './parse'
export {
  generateCurl,
  generateCurlMultiline,
  generateCurlSingleLine,
  buildUrlWithQuery,
  encodeKeepingVars
} from './generate'
export { buildArgv, type AgentArgv } from './agent-argv'
export {
  extractVars,
  resolveText,
  resolveSpec,
  findUnresolvedVars,
  toVarMap,
  type VarMap,
  type ResolveResult
} from './variables'
export {
  normalizeSpec,
  parseCollection,
  buildCollection,
  serializeCollection,
  redactSpec,
  hasSensitive,
  REDACTED_MASK,
  isRedactedValue,
  hasRedactedValues
} from './collection'
