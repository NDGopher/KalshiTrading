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

  if (analysis.confidence < 0.3) {
    flags.push(`Low model confidence (${(analysis.confidence * 100).toFixed(0)}%)`);
  }

  const reasoningLower = analysis.reasoning.toLowerCase();
  const hallucinationPatterns = [
    "failed", "default", "unable to", "cannot determine",
    "no data available", "i don't have", "i cannot access",
    "as an ai", "i'm not sure", "breaking news",
    "unverified report", "sources say",
  ];
  const hallucinationHits = hallucinationPatterns.filter((p) => reasoningLower.includes(p));
  if (hallucinationHits.length > 0) {
    flags.push(`Analysis reliability concern: matched ${hallucinationHits.length} warning pattern(s): ${hallucinationHits.join(", ")}`);
  }

  if (analysis.reasoning.length < 50) {
    flags.push("Reasoning too short — possible analysis failure");
  }

  const penaltyPerFlag = settings.confidencePenaltyPct / 100;
  adjustedConfidence = Math.max(0, adjustedConfidence - (flags.length * penaltyPerFlag));

  const approved = flags.length === 0 || (flags.length <= 1 && adjustedConfidence > 0.4 && analysis.edge >= settings.minEdge);

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
