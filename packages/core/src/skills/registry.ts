import type { Skill } from './types.js'

const registry = new Map<string, Skill>()

export function registerSkill(skill: Skill): void {
  registry.set(skill.name, skill)
}

export function getSkill(name: string): Skill | undefined {
  return registry.get(name)
}

export function getAllSkills(): Skill[] {
  return Array.from(registry.values())
}
