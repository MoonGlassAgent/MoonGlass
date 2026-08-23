/** 会话文本中的项目文件引用，支持 Windows 绝对路径与项目相对路径。 */
const WINDOWS_ABSOLUTE = String.raw`[A-Za-z]:[\\/](?:[^\r\n"'<>|?*:\\/]+[\\/])*[^\r\n"'<>|?*:\\/]+\.[a-zA-Z0-9_+-]+(?::\d+)?(?::\d+)?`
const PROJECT_RELATIVE = String.raw`(?:[\w.@+()-]+[\\/])+[\w.@+()-]+\.[a-zA-Z0-9_+-]+(?::\d+)?(?::\d+)?`

export const FILE_REFERENCE_SOURCE = `(?:${WINDOWS_ABSOLUTE}|${PROJECT_RELATIVE})`

export function isFileReference(value: string): boolean {
  return new RegExp(`^${FILE_REFERENCE_SOURCE}$`).test(value)
}

export function extractFileReference(value: string): string | null {
  return value.match(new RegExp(FILE_REFERENCE_SOURCE))?.[0] ?? null
}
