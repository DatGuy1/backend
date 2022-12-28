import { getPlayers } from '../../dota/lib/getPlayers.js'
import { getRankDetail, rankTierToMmr } from './ranks.js'

export async function calculateAvg(
  currentMatchId?: string,
  players?: { heroid: number; accountid: number }[],
): Promise<string> {
  const { cards } = await getPlayers(currentMatchId, players)

  const mmrs: number[] = []
  cards.forEach((card) => {
    mmrs.push(rankTierToMmr(card.rank_tier))
  })

  // Get average of all numbers in mmrs array
  const avg = Math.round(mmrs.reduce((a, b) => a + b, 0) / mmrs.length)
  const avgMsg = `${avg}`
  const rank = await getRankDetail(avg)
  if (!rank) return avgMsg

  if ('standing' in rank) {
    return `Immortal - Average rank this game`
  }

  return `${avg} · ${rank.myRank.title} - Average rank this game`
}
