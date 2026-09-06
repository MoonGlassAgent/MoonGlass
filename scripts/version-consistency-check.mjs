import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const appInfo = readFileSync('src/shared/app-info.ts', 'utf8')
const match = appInfo.match(/version:\s*['"]([^'"]+)['"]/) 

if (!match) throw new Error('无法读取 APP_INFO.version')
if (match[1] !== packageJson.version) {
  throw new Error(`版本号不一致: package.json=${packageJson.version}, APP_INFO=${match[1]}`)
}

console.log(`Version consistency check passed: ${packageJson.version}`)
