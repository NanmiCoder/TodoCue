/** Turns whatever a failed call threw into one short sentence for the person using the panel. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export const isVersionConflict = (error: unknown) => errorCode(error) === "VERSION_CONFLICT";
export const isNotFound = (error: unknown) => errorCode(error) === "NOT_FOUND";

function isValidationFailure(error: unknown): boolean {
  const value = error as { name?: string; issues?: unknown } | null;
  return value?.name === "ZodError" || Array.isArray(value?.issues);
}

export function describeError(error: unknown, language: string): string {
  const en = language === "en";
  if (isVersionConflict(error)) return en ? "Changed elsewhere. Refreshed." : "任务已在别处修改，已刷新";
  if (isNotFound(error)) return en ? "That item no longer exists." : "找不到这一项，可能已被删除";
  if (isValidationFailure(error)) return en ? "Some fields are not valid. Check and try again." : "有些内容不合法，请检查后重试";
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** What a failed write shows, and whether the board it was based on is out of date. */
export function failureOf(error: unknown, language: string): { message: string; reload: boolean } {
  return { message: describeError(error, language), reload: isVersionConflict(error) };
}
