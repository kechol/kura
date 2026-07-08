/** 引数・入力エラー（exit 2） */
export class UsageError extends Error {}

/** 対象なし（exit 3） */
export class NotFoundError extends Error {}

/** 一意制約などの衝突（exit 1） */
export class ConflictError extends Error {}

/** LLM プロバイダ利用不可（exit 4） */
export class LLMUnavailableError extends Error {}
