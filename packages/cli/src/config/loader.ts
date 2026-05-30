import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { MechConfig } from './schema.js'

/**
 * 加载并合并全局与项目级别的配置文件。
 * 优先级：CLI 参数 > .mech.json（项目级）> ~/.mech/config.json（全局）> 环境变量
 */
export async function loadConfig(): Promise<MechConfig> {
  const globalConfig = await loadJsonFile(join(homedir(), '.mech', 'config.json'))
  const projectConfig = await loadJsonFile(join(process.cwd(), '.mech.json'))

  return {
    ...globalConfig,
    ...projectConfig,
  }
}

async function loadJsonFile(path: string): Promise<MechConfig> {
  try {
    const content = await readFile(path, 'utf-8')
    return JSON.parse(content) as MechConfig
  } catch {
    return {}
  }
}
