import type { AnalysisResult } from "./analyst.js";

export interface AuditResult {
  analysis: AnalysisResult;
  approved: boolean;
  flags: string[];
  adjustedConfidence: number;
}

export function auditTrade(
  analysis: AnalysisResult,
  settings: {
    minLiquidity: number;
    minTimeToExpiry: number;
    confidencePenaltyPct: number;
    minEdge: number;
  }
): AuditResult {
  const flags: string[] = [];
  let adjustedConfidence = analysis.confidence;

  if (analysis.candidate.hoursToExpiry < settings.minTimeToExpiry / 60) {
    flags.push(`Too close to expiry (${analysis.candidate.hoursToExpiry.toFixed(1)}h remaining, min ${(settings.minTimeToExpiry / 60).toFixed(1)}h)`);
  }

  if (analysis.candidate.liquidity < settings.minLiquidity) {
    flags.push(`Low liquidity ($${analysis.candidate.liquidity.toFixed(2)}, min $${settings.minLiquidity})`);
  }

  if (analysis.candidate.spread > 0.15) {
    flags.push(`Wide spread ($${analysis.candidate.spread.toFixed(4)})`);
  }

  if (analysis.edge < settings.minEdge) {
    flags.push(`Insufficient edge (${analysis.edge.toFixed(1)}%, min ${settings.minEdge}%)`);
  }

  // Confidence threshold: 20% minimum. Game-day sports markets routinely land at 25-35%
  // without real-time injury/line data — this is honest uncertainty, not bad analysis.
  if (analysis.confidence < 0.20) {
    flags.push(`Low model confidence (${(analysis.confidence * 100).toFixed(0)}%)`);
  }

  // Hallucination detection: only flag patterns that indicate a COMPLETE analysis failure
  // (AI couldn't perform the task at all). Do NOT flag legitimate epistemic uncertainty
  // ("I'm not sure about X but my analysis suggests Y").
  const reasoningLower = analysis.reasoning.toLowerCase();
  const isRuleBasedKeeper = analysis.reasoning.startsWith("RB:") || reasoningLower.includes("rule-based");
  const hardFailurePatterns = [
    "unable to access",
    "i cannot access",
    "no data available",
    "as an ai, i",
    "breaking news",
    "unverified report",
  ];
  const hallucinationHits = hardFailurePatterns.filter((p) => reasoningLower.includes(p));
  if (!isRuleBasedKeeper && hallucinationHits.length > 0) {
    flags.push(`Analysis reliability concern: matched ${hallucinationHits.length} failure pattern(s): ${hallucinationHits.join(", ")}`);
  }

  // Keeper stack uses one-line RB: reasons (~30 chars). Do not apply the LLM-era length gate.
  if (!isRuleBasedKeeper && analysis.reasoning.length < 50) {
    flags.push("Reasoning too short — possible analysis failure");
  }

  const penaltyPerFlag = settings.confidencePenaltyPct / 100;
  adjustedConfidence = Math.max(0, adjustedConfidence - (flags.length * penaltyPerFlag));

  const approved = flags.length === 0;

  return {
    analysis,
    approved,
    flags,
    adjustedConfidence,
  };
}

export function auditTrades(
  analyses: AnalysisResult[],
  settings: {
    minLiquidity: number;
    minTimeToExpiry: number;
    confidencePenaltyPct: number;
    minEdge: number;
  }
): AuditResult[] {
  return analyses.map((a) => auditTrade(a, settings));
}
