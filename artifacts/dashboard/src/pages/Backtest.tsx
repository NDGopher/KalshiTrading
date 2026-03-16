import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { FlaskConical, Play, BarChart3, Target, ChevronDown, ChevronRight, TrendingUp, Crosshair, Award, ChevronLeft } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
  ScatterChart, Scatter, ReferenceLine
} from "recharts";
import { motion, AnimatePresence } from "framer-motion";

interface BacktestRun {
  id: number;
  strategyName: string;
  status: string;
  startDate: string;
  endDate: string;
  marketsEvaluated: number;
  tradesSimulated: number;
  totalPnl: number;
  winRate: number;
  roi: number | null;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  avgEdge: number | null;
  avgClv: number | null;
  bestStreak: number | null;
  worstStreak: number | null;
  dipCatchSuccessRate: number | null;
  createdAt: string;
}

interface BacktestTrade {
  id: number;
  kalshiTicker: string;
  title: string;
  strategyName: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  outcome: string;
  clv: number | null;
  modelProbability: number;
  edge: number;
  confidence: number;
  reasoning: string | null;
  marketResult: string | null;
  dipCatch: boolean | null;
  distanceFromPeak: number | null;
}

interface StrategySummary {
  strategyName: string;
  totalRuns: number;
  totalTrades: number;
  avgPnl: number;
  avgWinRate: number;
  avgRoi: number | null;
  avgClv: number | null;
  avgSharpe: number | null;
  dipCatchSuccessRate: number | null;
  bestRunId: number | null;
  bestRunPnl: number | null;
}

const API_BASE = `${import.meta.env.BASE_URL}api`;
const STRATEGY_COLORS = ["#a78bfa", "#34d399", "#f59e0b", "#60a5fa", "#f87171"];
const PAGE_SIZE = 20;

function useStrategies() {
  return useQuery({
    queryKey: ["/api/backtest/strategies"],
    queryFn: async () => { const res = await fetch(`${API_BASE}/backtest/strategies`); return res.json() as Promise<{ strategies: string[] }>; },
  });
}

function useBacktestResults() {
  return useQuery({
    queryKey: ["/api/backtest/results"],
    queryFn: async () => { const res = await fetch(`${API_BASE}/backtest/results`); return res.json() as Promise<{ runs: BacktestRun[]; strategyAggregates: StrategySummary[] }>; },
    refetchInterval: 5000,
  });
}

function useBacktestTrades(runId: number | null) {
  return useQuery({
    queryKey: ["/api/backtest/trades", runId],
    queryFn: async () => {
      if (!runId) return { trades: [] as BacktestTrade[] };
      const res = await fetch(`${API_BASE}/backtest/trades/${runId}`);
      return res.json() as Promise<{ trades: BacktestTrade[] }>;
    },
    enabled: !!runId,
  });
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card/95 border border-white/10 rounded-lg p-3 text-xs shadow-xl backdrop-blur-sm">
      <div className="font-semibold text-white mb-1.5">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono text-white">{typeof p.value === "number" ? p.value.toFixed(2) : p.value}{p.unit || ""}</span>
        </div>
      ))}
    </div>
  );
}

function TradeRow({ trade }: { trade: BacktestTrade }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr
        className="hover:bg-white/5 transition-colors cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <td className="p-3">
          <div className="flex items-center gap-1.5">
            {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
            <div className="max-w-[160px] truncate text-white text-xs" title={trade.title}>{trade.title}</div>
          </div>
        </td>
        <td className="p-3 text-xs text-muted-foreground">{trade.strategyName}</td>
        <td className="p-3 text-center">
          <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${trade.side === "yes" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{trade.side}</span>
        </td>
        <td className="p-3 text-right font-mono text-white text-xs">${trade.entryPrice.toFixed(2)}</td>
        <td className="p-3 text-right font-mono text-muted-foreground text-xs">{trade.exitPrice != null ? `$${trade.exitPrice.toFixed(2)}` : "-"}</td>
        <td className="p-3 text-right font-mono text-white text-xs">{trade.edge.toFixed(1)}%</td>
        <td className={`p-3 text-right font-mono text-xs ${trade.clv != null ? (trade.clv >= 0 ? "text-green-400" : "text-red-400") : "text-muted-foreground"}`}>
          {trade.clv != null ? (trade.clv * 100).toFixed(2) + "c" : "-"}
        </td>
        <td className="p-3 text-right font-mono text-xs text-muted-foreground">
          {trade.dipCatch && trade.distanceFromPeak != null ? `${(Math.abs(trade.distanceFromPeak) * 100).toFixed(1)}%` : "—"}
        </td>
        <td className={`p-3 text-right font-mono font-bold text-xs ${trade.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>${trade.pnl.toFixed(2)}</td>
        <td className="p-3 text-center text-xs text-muted-foreground">{trade.marketResult || "-"}</td>
        <td className="p-3 text-center">
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${trade.outcome === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{trade.outcome}</span>
        </td>
      </tr>
      <AnimatePresence>
        {expanded && trade.reasoning && (
          <tr>
            <td colSpan={11}>
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="px-8 py-3 bg-black/30 border-t border-white/5 text-[11px] text-muted-foreground leading-relaxed font-mono">
                  <span className="text-primary/70 font-semibold">AI Reasoning: </span>{trade.reasoning}
                  {trade.dipCatch && (
                    <div className="mt-1.5 text-success/70">
                      <span className="font-semibold">Dip Catch: </span>
                      Distance from peak: {trade.distanceFromPeak != null ? `${(trade.distanceFromPeak * 100).toFixed(1)}%` : "N/A"}
                    </div>
                  )}
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

export default function Backtest() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: strategiesData } = useStrategies();
  const { data: resultsData } = useBacktestResults();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const { data: tradesData } = useBacktestTrades(selectedRunId);
  const [tradePage, setTradePage] = useState(0);

  const [strategy, setStrategy] = useState("All");
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2025-12-31");
  const [initialBankroll, setInitialBankroll] = useState(5000);
  const [useAi, setUseAi] = useState(false);
  const [running, setRunning] = useState(false);
  const [pendingRunIds, setPendingRunIds] = useState<number[]>([]);

  const runBacktest = async () => {
    setRunning(true);
    try {
      const res = await fetch(`${API_BASE}/backtest/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyName: strategy, startDate, endDate, initialBankroll, useAiAnalysis: useAi }),
      });
      const data = await res.json();
      if (data.error) {
        toast({ title: "Error", description: data.error, variant: "destructive" });
      } else if (data.runIds?.length) {
        setPendingRunIds(data.runIds);
        if (data.runIds.length === 1) setSelectedRunId(data.runIds[0]);
        setTradePage(0);
        toast({
          title: "Backtest Running",
          description: data.message || `Fetching historical data and simulating trades. Results appear below as each strategy completes.`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/backtest/results"] });
      }
    } catch {
      toast({ title: "Error", description: "Failed to start backtest", variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const runs = resultsData?.runs || [];
  const trades = tradesData?.trades || [];
  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const strategySummaries = resultsData?.strategyAggregates || [];

  const chartData = useMemo(() =>
    strategySummaries.map((s, i) => ({
      name: s.strategyName.replace("Pure Value", "Pure Val").replace("Fade the Public", "Fade Pub").replace("Late Efficiency", "Late Eff").replace("Dip Buyer", "Dip Buy"),
      "Win Rate %": parseFloat((s.avgWinRate * 100).toFixed(1)),
      "ROI %": s.avgRoi != null ? parseFloat(s.avgRoi.toFixed(1)) : 0,
      "Avg CLV": s.avgClv != null ? parseFloat((s.avgClv * 100).toFixed(2)) : 0,
      color: STRATEGY_COLORS[i % STRATEGY_COLORS.length],
    })),
    [strategySummaries]
  );

  const dipTrades = trades.filter(t => t.dipCatch === true);
  const nonDipTrades = trades.filter(t => t.dipCatch !== true);
  const dipWins = dipTrades.filter(t => t.outcome === "won").length;
  const nonDipWins = nonDipTrades.filter(t => t.outcome === "won").length;
  const dipWinRate = dipTrades.length > 0 ? dipWins / dipTrades.length : 0;
  const nonDipWinRate = nonDipTrades.length > 0 ? nonDipWins / nonDipTrades.length : 0;
  const avgDipDepth = dipTrades.length > 0
    ? dipTrades.reduce((sum, t) => sum + (t.distanceFromPeak || 0), 0) / dipTrades.length
    : 0;
  const bestDip = dipTrades.reduce<BacktestTrade | null>((best, t) => t.pnl > (best?.pnl ?? -Infinity) ? t : best, null);
  const worstDip = dipTrades.reduce<BacktestTrade | null>((worst, t) => t.pnl < (worst?.pnl ?? Infinity) ? t : worst, null);

  const dipDepthOutcomeData = useMemo(() => {
    if (!dipTrades.length) return [];
    const buckets: Record<string, { won: number; lost: number }> = {};
    for (const t of dipTrades) {
      const depth = Math.abs(t.distanceFromPeak || 0);
      const label = depth < 0.05 ? "<5%" : depth < 0.1 ? "5-10%" : depth < 0.2 ? "10-20%" : "20%+";
      if (!buckets[label]) buckets[label] = { won: 0, lost: 0 };
      if (t.outcome === "won") buckets[label].won++;
      else buckets[label].lost++;
    }
    const order = ["<5%", "5-10%", "10-20%", "20%+"];
    return order.filter(k => buckets[k]).map(label => ({
      label,
      won: buckets[label].won,
      lost: buckets[label].lost,
      winRate: parseFloat(((buckets[label].won / (buckets[label].won + buckets[label].lost)) * 100).toFixed(1)),
    }));
  }, [dipTrades]);

  const top5BestDips = [...dipTrades].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  const top5WorstDips = [...dipTrades].sort((a, b) => a.pnl - b.pnl).slice(0, 5);

  const clvTrades = trades.filter(t => t.clv != null);
  const clvHistogram = useMemo(() => {
    if (!clvTrades.length) return [];
    const BUCKET_SIZE = 0.02;
    const buckets: Record<string, number> = {};
    for (const t of clvTrades) {
      const v = t.clv!;
      const bucket = Math.floor(v / BUCKET_SIZE) * BUCKET_SIZE;
      const label = `${(bucket * 100).toFixed(0)}c`;
      buckets[label] = (buckets[label] || 0) + 1;
    }
    return Object.entries(buckets).sort(([a], [b]) => parseFloat(a) - parseFloat(b)).map(([label, count]) => ({ label, count, positive: parseFloat(label) >= 0 }));
  }, [clvTrades]);

  const strategyClv = useMemo(() => {
    const map = new Map<string, { name: string; clvSum: number; count: number }>();
    for (const t of clvTrades) {
      const key = t.strategyName || "Unknown";
      if (!map.has(key)) map.set(key, { name: key, clvSum: 0, count: 0 });
      const s = map.get(key)!;
      s.clvSum += t.clv!;
      s.count++;
    }
    return Array.from(map.values())
      .map(s => ({ ...s, avgClv: s.count > 0 ? s.clvSum / s.count : 0 }))
      .sort((a, b) => b.avgClv - a.avgClv);
  }, [clvTrades]);

  const clvPnlScatter = useMemo(() =>
    clvTrades.filter(t => t.pnl != null).map(t => ({ clv: (t.clv!) * 100, pnl: t.pnl, won: t.outcome === "won", title: t.title })),
    [clvTrades]
  );

  const clvLeaderboard = useMemo(() =>
    [...clvTrades].sort((a, b) => (b.clv!) - (a.clv!)).slice(0, 10),
    [clvTrades]
  );

  const avgClv = clvTrades.length > 0 ? clvTrades.reduce((s, t) => s + t.clv!, 0) / clvTrades.length : 0;
  const clvHitRate = clvTrades.length > 0 ? clvTrades.filter(t => t.clv! >= 0).length / clvTrades.length : 0;

  const pageTrades = trades.slice(tradePage * PAGE_SIZE, (tradePage + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(trades.length / PAGE_SIZE);

  return (
    <Layout>
      <div className="space-y-8">
        <div>
          <h2 className="text-3xl font-bold font-display text-white tracking-tight">Backtesting Engine</h2>
          <p className="text-muted-foreground mt-1">Test strategies against historical settled markets.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20">
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="w-5 h-5 text-primary" />
                Run Backtest
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Strategy</label>
                <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white">
                  <option value="All">All Strategies</option>
                  {(strategiesData?.strategies || ["Pure Value"]).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Start Date</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">End Date</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Initial Bankroll ($)</label>
                <input type="number" value={initialBankroll} onChange={(e) => setInitialBankroll(Number(e.target.value))} className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="h-4 w-4 rounded border-white/10 bg-black/50" />
                <label className="text-sm text-muted-foreground">Use AI analysis (costs API credits)</label>
              </div>
              <Button onClick={runBacktest} disabled={running} className="w-full bg-primary text-black hover:bg-primary/90 font-semibold">
                {running
                  ? <span className="flex items-center gap-2"><span className="animate-spin w-4 h-4 border-2 border-black/30 border-t-black rounded-full" /> Starting...</span>
                  : <span className="flex items-center gap-2"><Play className="w-4 h-4" /> Run Backtest</span>
                }
              </Button>
              {pendingRunIds.length > 0 && (() => {
                const pendingRuns = runs.filter(r => pendingRunIds.includes(r.id) && r.status === "running");
                const completedPending = runs.filter(r => pendingRunIds.includes(r.id) && r.status !== "running");
                return pendingRuns.length > 0 ? (
                  <div className="rounded-lg bg-primary/10 border border-primary/20 p-3 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs text-primary font-semibold">
                      <span className="animate-spin w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full" />
                      Fetching historical data from Kalshi...
                    </div>
                    {pendingRuns.map(r => (
                      <div key={r.id} className="text-[10px] text-muted-foreground pl-5">{r.strategyName} — in progress</div>
                    ))}
                    {completedPending.map(r => (
                      <div key={r.id} className="text-[10px] text-success pl-5">{r.strategyName} — {r.tradesSimulated} trades done</div>
                    ))}
                    <div className="text-[10px] text-muted-foreground/60 pt-1">Results appear below as each strategy completes. Page auto-refreshes every 5s.</div>
                  </div>
                ) : null;
              })()}
            </CardContent>
          </Card>

          <div className="lg:col-span-2 space-y-4">
            {runs.length > 0 && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                  <CardTitle className="text-sm flex items-center gap-2">Previous Runs — click to view trades</CardTitle>
                </CardHeader>
                <CardContent className="p-0 max-h-48 overflow-y-auto">
                  {runs.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => { setSelectedRunId(r.id); setTradePage(0); }}
                      className={`w-full flex items-center justify-between px-4 py-2.5 text-left text-xs hover:bg-white/[0.03] transition-colors border-b border-white/5 last:border-0 ${selectedRunId === r.id ? "bg-white/[0.05]" : ""}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${r.status === "running" ? "bg-yellow-400 animate-pulse" : r.status === "completed" ? "bg-success" : "bg-destructive"}`} />
                        <span className="font-medium text-white truncate">{r.strategyName}</span>
                        <span className="text-muted-foreground">{r.startDate?.slice(0, 7)} → {r.endDate?.slice(0, 7)}</span>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                        {r.status === "running" ? (
                          <span className="text-yellow-400">Running...</span>
                        ) : r.status === "completed" ? (
                          <>
                            <span className={`font-mono font-bold ${r.totalPnl >= 0 ? "text-success" : "text-destructive"}`}>{r.totalPnl >= 0 ? "+" : ""}${r.totalPnl?.toFixed(0)}</span>
                            <span className="text-muted-foreground">{r.tradesSimulated}t</span>
                            <span className="text-muted-foreground">{(r.winRate * 100).toFixed(0)}%WR</span>
                          </>
                        ) : (
                          <span className="text-destructive">Error</span>
                        )}
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}
            {selectedRun && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Total P&L</div>
                    <div className={`text-2xl font-mono font-bold mt-1 ${selectedRun.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>${selectedRun.totalPnl?.toFixed(2)}</div>
                  </CardContent></Card>
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Win Rate</div>
                    <div className="text-2xl font-mono font-bold mt-1 text-white">{(selectedRun.winRate * 100).toFixed(1)}%</div>
                  </CardContent></Card>
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">ROI</div>
                    <div className={`text-2xl font-mono font-bold mt-1 ${(selectedRun.roi ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{selectedRun.roi?.toFixed(1) ?? "N/A"}%</div>
                  </CardContent></Card>
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Sharpe</div>
                    <div className="text-2xl font-mono font-bold mt-1 text-white">{selectedRun.sharpeRatio?.toFixed(2) || "N/A"}</div>
                  </CardContent></Card>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Trades</div>
                    <div className="text-lg font-mono font-bold mt-1 text-white">{selectedRun.tradesSimulated}</div>
                  </CardContent></Card>
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Avg CLV</div>
                    <div className={`text-lg font-mono font-bold mt-1 ${(selectedRun.avgClv ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{selectedRun.avgClv != null ? (selectedRun.avgClv * 100).toFixed(2) + "c" : "N/A"}</div>
                  </CardContent></Card>
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Best/Worst Streak</div>
                    <div className="text-lg font-mono font-bold mt-1 text-white">{selectedRun.bestStreak ?? 0}W / {selectedRun.worstStreak ?? 0}L</div>
                  </CardContent></Card>
                  <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Dip Catch Rate</div>
                    <div className="text-lg font-mono font-bold mt-1 text-white">{selectedRun.dipCatchSuccessRate != null ? (selectedRun.dipCatchSuccessRate * 100).toFixed(1) + "%" : "N/A"}</div>
                  </CardContent></Card>
                </div>
              </>
            )}
          </div>
        </div>

        {chartData.length > 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20">
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-primary" />
                Strategy Comparison
              </CardTitle>
              <CardDescription>Win Rate, ROI, and CLV across all strategies — higher is better</CardDescription>
            </CardHeader>
            <CardContent className="p-6">
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }} barGap={4} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend wrapperStyle={{ paddingTop: "16px", fontSize: "11px", color: "#9ca3af" }} />
                    <Bar dataKey="Win Rate %" radius={[3, 3, 0, 0]} fill="#a78bfa" unit="%" maxBarSize={40} />
                    <Bar dataKey="ROI %" radius={[3, 3, 0, 0]} fill="#34d399" unit="%" maxBarSize={40} />
                    <Bar dataKey="Avg CLV" radius={[3, 3, 0, 0]} fill="#60a5fa" unit="c" maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4">
                {strategySummaries.map((s, i) => (
                  <div key={s.strategyName} className="p-3 rounded-lg bg-black/30 border border-white/5 text-center">
                    <div className="w-2 h-2 rounded-full mx-auto mb-1" style={{ background: STRATEGY_COLORS[i % STRATEGY_COLORS.length] }} />
                    <div className="text-[10px] text-muted-foreground font-medium truncate">{s.strategyName}</div>
                    <div className="text-sm font-mono font-bold text-white mt-1">{(s.avgWinRate * 100).toFixed(0)}% WR</div>
                    <div className={`text-[10px] font-mono ${(s.avgRoi ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>{s.avgRoi != null ? `${s.avgRoi.toFixed(1)}%` : "—"} ROI</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {clvTrades.length > 0 && (
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Target className="w-5 h-5 text-primary" />
                CLV Analytics — Run #{selectedRunId}
              </h3>
              <Badge variant="outline" className="text-[10px]">{clvTrades.length} trades with CLV</Badge>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Avg CLV</div>
                <div className={`text-xl font-mono font-bold ${avgClv >= 0 ? "text-success" : "text-destructive"}`}>{(avgClv * 100).toFixed(2)}c</div>
                <p className="text-[10px] text-muted-foreground mt-1">Closing line value per contract</p>
              </CardContent></Card>
              <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">CLV Hit Rate</div>
                <div className="text-xl font-mono font-bold text-white">{(clvHitRate * 100).toFixed(1)}%</div>
                <p className="text-[10px] text-muted-foreground mt-1">Trades where CLV was positive</p>
              </CardContent></Card>
              <Card className="glass-panel border-white/10"><CardContent className="p-4 text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Best CLV</div>
                <div className="text-xl font-mono font-bold text-success">{clvLeaderboard.length > 0 ? `${(clvLeaderboard[0].clv! * 100).toFixed(2)}c` : "—"}</div>
                <p className="text-[10px] text-muted-foreground mt-1 truncate">{clvLeaderboard.length > 0 ? clvLeaderboard[0].title : ""}</p>
              </CardContent></Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {clvHistogram.length > 0 && (
                <Card className="glass-panel border-white/10">
                  <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-primary" />CLV Distribution Histogram
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={clvHistogram} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                          <Tooltip content={<CustomTooltip />} />
                          <ReferenceLine x="0c" stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
                          <Bar dataKey="count" name="Trades" radius={[2, 2, 0, 0]} maxBarSize={30}>
                            {clvHistogram.map((b) => <Cell key={b.label} fill={b.positive ? "#34d399" : "#f87171"} fillOpacity={0.8} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              )}

              {strategyClv.length > 0 && (
                <Card className="glass-panel border-white/10">
                  <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-accent" />Avg CLV by Strategy
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={strategyClv} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis type="number" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v * 100).toFixed(1)}c`} />
                          <YAxis dataKey="name" type="category" tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} width={70} tickFormatter={(s: string) => s.split(" ")[0]} />
                          <Tooltip content={<CustomTooltip />} />
                          <ReferenceLine x={0} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
                          <Bar dataKey="avgClv" name="Avg CLV" radius={[0, 3, 3, 0]} maxBarSize={20}>
                            {strategyClv.map((s) => <Cell key={s.name} fill={s.avgClv >= 0 ? "#34d399" : "#f87171"} fillOpacity={0.85} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {clvPnlScatter.length > 0 && (
                <Card className="glass-panel border-white/10">
                  <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Target className="w-4 h-4 text-primary" />CLV vs P&L Scatter
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="clv" name="CLV" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} label={{ value: "CLV (c)", position: "insideBottom", offset: -2, fill: "#6b7280", fontSize: 9 }} />
                          <YAxis dataKey="pnl" name="P&L" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
                          <Tooltip content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload;
                            return (
                              <div className="bg-card/95 border border-white/10 rounded-lg p-3 text-xs shadow-xl backdrop-blur-sm">
                                <div className="font-semibold text-white mb-1 max-w-[180px] truncate">{d.title}</div>
                                <div className="font-mono text-muted-foreground">CLV: {d.clv.toFixed(2)}c</div>
                                <div className={`font-mono font-bold ${d.pnl >= 0 ? "text-success" : "text-destructive"}`}>P&L: ${d.pnl.toFixed(2)}</div>
                              </div>
                            );
                          }} />
                          <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                          <Scatter name="Trades" data={clvPnlScatter}>
                            {clvPnlScatter.map((d, i) => <Cell key={i} fill={d.won ? "#34d399" : "#f87171"} fillOpacity={0.8} />)}
                          </Scatter>
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="text-[10px] text-muted-foreground/60 text-center mt-2">Green = won · Red = lost</p>
                  </CardContent>
                </Card>
              )}

              {clvLeaderboard.length > 0 && (
                <Card className="glass-panel border-white/10">
                  <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Award className="w-4 h-4 text-yellow-400" />CLV Leaderboard
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y divide-white/5">
                      {clvLeaderboard.map((t, i) => (
                        <div key={t.id} className="flex items-center gap-3 px-4 py-2 hover:bg-white/[0.02]">
                          <span className={`text-xs font-bold w-5 text-center ${i === 0 ? "text-yellow-400" : i === 1 ? "text-gray-300" : i === 2 ? "text-amber-600" : "text-muted-foreground"}`}>#{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-semibold text-white truncate">{t.title}</div>
                            <div className="text-[10px] text-muted-foreground">{t.strategyName}</div>
                          </div>
                          <div className="text-right">
                            <div className={`text-sm font-mono font-bold ${(t.clv!) >= 0 ? "text-success" : "text-destructive"}`}>{(t.clv! * 100).toFixed(2)}c</div>
                            <div className={`text-[10px] font-mono ${t.pnl >= 0 ? "text-success/70" : "text-destructive/70"}`}>${t.pnl.toFixed(2)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}

        {dipTrades.length > 0 && selectedRun && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20">
              <CardTitle className="flex items-center gap-2"><Crosshair className="w-5 h-5 text-accent" />Dip Catch Analytics</CardTitle>
              <CardDescription>Run #{selectedRunId}: dip-buying performance vs general market entry</CardDescription>
            </CardHeader>
            <CardContent className="p-6 space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Dip Catches</div>
                  <div className="text-2xl font-mono font-bold text-white">{dipTrades.length}</div>
                </div>
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Dip Win Rate</div>
                  <div className={`text-2xl font-mono font-bold ${dipWinRate >= 0.5 ? "text-success" : "text-destructive"}`}>{(dipWinRate * 100).toFixed(0)}%</div>
                </div>
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Non-Dip Win Rate</div>
                  <div className={`text-2xl font-mono font-bold ${nonDipWinRate >= 0.5 ? "text-success" : "text-destructive"}`}>{nonDipTrades.length > 0 ? `${(nonDipWinRate * 100).toFixed(0)}%` : "—"}</div>
                </div>
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Avg Dip Depth</div>
                  <div className="text-2xl font-mono font-bold text-white">{(avgDipDepth * 100).toFixed(1)}%</div>
                  <div className="text-[10px] text-muted-foreground">from peak</div>
                </div>
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Dip vs Non-Dip</div>
                  <div className={`text-lg font-mono font-bold ${dipWinRate >= nonDipWinRate ? "text-success" : "text-destructive"}`}>
                    {dipWinRate >= nonDipWinRate ? `+${((dipWinRate - nonDipWinRate) * 100).toFixed(1)}pp` : `${((dipWinRate - nonDipWinRate) * 100).toFixed(1)}pp`}
                  </div>
                  <div className="text-[10px] text-muted-foreground">win rate advantage</div>
                </div>
              </div>

              {dipDepthOutcomeData.length > 0 && (
                <div>
                  <div className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-primary" /> Dip Depth vs Outcome
                  </div>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dipDepthOutcomeData} barCategoryGap="30%">
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: "10px", color: "#9ca3af" }} />
                        <Bar dataKey="won" name="Won" fill="#34d399" fillOpacity={0.8} radius={[2, 2, 0, 0]} maxBarSize={40} />
                        <Bar dataKey="lost" name="Lost" fill="#f87171" fillOpacity={0.8} radius={[2, 2, 0, 0]} maxBarSize={40} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <div className="text-xs font-semibold text-success/80 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Award className="w-3.5 h-3.5" /> Top 5 Best Dip Catches
                  </div>
                  <div className="space-y-2">
                    {top5BestDips.map((t, i) => (
                      <div key={t.id} className="flex items-center gap-2 p-2 rounded bg-black/20 border border-white/5">
                        <span className="text-xs font-bold text-success w-4">#{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-white truncate">{t.title}</div>
                          <div className="text-[10px] text-muted-foreground">{t.distanceFromPeak != null ? `${(t.distanceFromPeak * 100).toFixed(1)}% from peak` : ""}</div>
                        </div>
                        <span className="text-xs font-mono font-bold text-success">${t.pnl.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-destructive/80 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Crosshair className="w-3.5 h-3.5" /> Top 5 Worst Dip Catches
                  </div>
                  <div className="space-y-2">
                    {top5WorstDips.map((t, i) => (
                      <div key={t.id} className="flex items-center gap-2 p-2 rounded bg-black/20 border border-white/5">
                        <span className="text-xs font-bold text-destructive w-4">#{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-white truncate">{t.title}</div>
                          <div className="text-[10px] text-muted-foreground">{t.distanceFromPeak != null ? `${(t.distanceFromPeak * 100).toFixed(1)}% from peak` : ""}</div>
                        </div>
                        <span className="text-xs font-mono font-bold text-destructive">${t.pnl.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {trades.length > 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20 flex flex-row items-center justify-between">
              <div>
                <CardTitle>Backtest Trades — Run #{selectedRunId}</CardTitle>
                <CardDescription>{trades.length} simulated trades — click a row to expand AI reasoning</CardDescription>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <button onClick={() => setTradePage(p => Math.max(0, p - 1))} disabled={tradePage === 0} className="p-1 rounded hover:bg-white/10 disabled:opacity-30">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span>Page {tradePage + 1} / {totalPages}</span>
                  <button onClick={() => setTradePage(p => Math.min(totalPages - 1, p + 1))} disabled={tradePage === totalPages - 1} className="p-1 rounded hover:bg-white/10 disabled:opacity-30">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card/90 backdrop-blur-sm border-b border-white/5">
                    <tr>
                      <th className="text-left p-3 text-muted-foreground font-medium">Market</th>
                      <th className="text-left p-3 text-muted-foreground font-medium">Strategy</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Side</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Entry</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Close</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Edge</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">CLV</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Dip Depth</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">P&L</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Settled</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {pageTrades.map((t) => <TradeRow key={t.id} trade={t} />)}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-white/5">
                  <span className="text-xs text-muted-foreground">Showing {tradePage * PAGE_SIZE + 1}–{Math.min((tradePage + 1) * PAGE_SIZE, trades.length)} of {trades.length}</span>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setTradePage(p => Math.max(0, p - 1))} disabled={tradePage === 0} className="h-7 px-2 text-xs">Prev</Button>
                    <Button variant="outline" size="sm" onClick={() => setTradePage(p => Math.min(totalPages - 1, p + 1))} disabled={tradePage === totalPages - 1} className="h-7 px-2 text-xs">Next</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {strategySummaries.length > 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20">
              <CardTitle className="flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" />Strategy Performance Summary</CardTitle>
              <CardDescription>Aggregated results across all backtest runs, grouped by strategy</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-white/10 bg-black/30">
                    <th className="text-left p-3 font-medium text-muted-foreground">Strategy</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Runs</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Trades</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Avg P&L</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Win Rate</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">ROI</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">CLV</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Sharpe</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Dip Catch</th>
                  </tr></thead>
                  <tbody>
                    {strategySummaries.map((s) => (
                      <tr key={s.strategyName} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="p-3 font-medium text-white">{s.strategyName}</td>
                        <td className="p-3 text-right font-mono text-white">{s.totalRuns}</td>
                        <td className="p-3 text-right font-mono text-white">{s.totalTrades}</td>
                        <td className={`p-3 text-right font-mono ${s.avgPnl >= 0 ? "text-green-400" : "text-red-400"}`}>${s.avgPnl.toFixed(2)}</td>
                        <td className="p-3 text-right font-mono text-white">{(s.avgWinRate * 100).toFixed(1)}%</td>
                        <td className={`p-3 text-right font-mono ${(s.avgRoi ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{s.avgRoi != null ? `${s.avgRoi.toFixed(1)}%` : "—"}</td>
                        <td className={`p-3 text-right font-mono ${(s.avgClv ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{s.avgClv != null ? `${(s.avgClv * 100).toFixed(1)}c` : "—"}</td>
                        <td className="p-3 text-right font-mono text-white">{s.avgSharpe != null ? s.avgSharpe.toFixed(2) : "—"}</td>
                        <td className="p-3 text-right font-mono text-white">{s.dipCatchSuccessRate != null ? `${(s.dipCatchSuccessRate * 100).toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20">
            <CardTitle className="flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" />Previous Runs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {runs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No backtest runs yet. Configure and run your first backtest above.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-white/5 bg-black/10">
                    <tr>
                      <th className="text-left p-3 text-muted-foreground font-medium">ID</th>
                      <th className="text-left p-3 text-muted-foreground font-medium">Strategy</th>
                      <th className="text-left p-3 text-muted-foreground font-medium">Period</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Markets</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Trades</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">P&L</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Win Rate</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Status</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {runs.map((r) => (
                      <tr key={r.id} className={`hover:bg-white/5 transition-colors ${selectedRunId === r.id ? "bg-primary/5" : ""}`}>
                        <td className="p-3 font-mono text-white">#{r.id}</td>
                        <td className="p-3 text-white">{r.strategyName}</td>
                        <td className="p-3 text-muted-foreground text-xs">{r.startDate} to {r.endDate}</td>
                        <td className="p-3 text-right font-mono text-white">{r.marketsEvaluated}</td>
                        <td className="p-3 text-right font-mono text-white">{r.tradesSimulated}</td>
                        <td className={`p-3 text-right font-mono font-bold ${r.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>${r.totalPnl?.toFixed(2)}</td>
                        <td className="p-3 text-right font-mono text-white">{(r.winRate * 100).toFixed(1)}%</td>
                        <td className="p-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${r.status === "completed" ? "bg-green-500/20 text-green-400" : r.status === "error" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"}`}>{r.status}</span>
                        </td>
                        <td className="p-3">
                          <Button variant="ghost" size="sm" onClick={() => { setSelectedRunId(r.id); setTradePage(0); }} className="text-primary hover:text-primary/80">View</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
