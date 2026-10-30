/** Gameplay categories; install state and Flash/HTML runtime are separate concerns. */
export const GAME_CATEGORIES=['动作','射击','冒险','策略','益智','棋牌','休闲','竞速','角色扮演','模拟'] as const
export function validGameCategories(value:unknown):value is string[]{
  return Array.isArray(value)&&value.length>=1&&value.length<=3&&new Set(value).size===value.length&&value.every(c=>typeof c==='string'&&(GAME_CATEGORIES as readonly string[]).includes(c))
}
