import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { FlaskConical, Play, BarChart3, Target, ChevronDown, ChevronRight, TrendingUp, Crosshair } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell
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
          <span className="font-mono text-white">{typeof p.value === "number" ? p.value.toFixed(1) : p.value}{p.unit || ""}</span>
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
        <td className="p-3 text-right font-mono text-white text-xs">{trade.edge.toFixed(1)}%</td>
        <td className={`p-3 text-right font-mono text-xs ${trade.clv != null ? (trade.clv >= 0 ? "text-green-400" : "text-red-400") : "text-muted-foreground"}`}>
          {trade.clv != null ? (trade.clv * 100).toFixed(2) + "%" : "-"}
        </td>
        <td className={`p-3 text-right font-mono font-bold text-xs ${trade.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>${trade.pnl.toFixed(2)}</td>
        <td className="p-3 text-center text-xs text-muted-foreground">{trade.marketResult || "-"}</td>
        <td className="p-3 text-center">
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${trade.outcome === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{trade.outcome}</span>
        </td>
        {trade.dipCatch != null && (
          <td className="p-3 text-center">
            {trade.dipCatch ? <span className="text-xs text-success">✓ Dip</span> : <span className="text-xs text-muted-foreground">—</span>}
          </td>
        )}
      </tr>
      <AnimatePresence>
        {expanded && trade.reasoning && (
          <tr>
            <td colSpan={10}>
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

  const [strategy, setStrategy] = useState("Pure Value");
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2025-03-01");
  const [initialBankroll, setInitialBankroll] = useState(5000);
  const [useAi, setUseAi] = useState(false);
  const [running, setRunning] = useState(false);

  const runBacktest = async () => {
    setRunning(true);
    try {
      const res = await fetch(`${API_BASE}/backtest/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyName: strategy, startDate, endDate, initialBankroll, useAiAnalysis: useAi }),
      });
      const data = await res.json();
      if (data.runId) {
        toast({ title: "Backtest Complete", description: `Run #${data.runId} finished` });
        queryClient.invalidateQueries({ queryKey: ["/api/backtest/results"] });
        setSelectedRunId(data.runId);
      } else {
        toast({ title: "Error", description: data.error || "Backtest failed", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to run backtest", variant: "destructive" });
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
      name: s.strategyName.replace(" the ", " ").replace("Pure Value", "Pure Val").replace("Fade the Public", "Fade Pub").replace("Late Efficiency", "Late Eff").replace("Dip Buyer", "Dip Buy"),
      "Win Rate %": parseFloat((s.avgWinRate * 100).toFixed(1)),
      "ROI %": s.avgRoi != null ? parseFloat(s.avgRoi.toFixed(1)) : 0,
      "Avg CLV": s.avgClv != null ? parseFloat((s.avgClv * 100).toFixed(2)) : 0,
      trades: s.totalTrades,
      color: STRATEGY_COLORS[i % STRATEGY_COLORS.length],
    })),
    [strategySummaries]
  );

  const dipTrades = trades.filter(t => t.dipCatch === true);
  const dipWins = dipTrades.filter(t => t.outcome === "won").length;
  const bestDip = dipTrades.reduce((best, t) => t.pnl > (best?.pnl || -Infinity) ? t : best, null as BacktestTrade | null);
  const worstDip = dipTrades.reduce((worst, t) => t.pnl < (worst?.pnl || Infinity) ? t : worst, null as BacktestTrade | null);

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
                {running ? "Running..." : <span className="flex items-center gap-2"><Play className="w-4 h-4" /> Run Backtest</span>}
              </Button>
            </CardContent>
          </Card>

          <div className="lg:col-span-2 space-y-6">
            {selectedRun && (
              <div className="space-y-4">
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
              </div>
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
              <CardDescription>Side-by-side performance across all backtest runs — higher is better for Win Rate and ROI</CardDescription>
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
                    <div className="text-[10px] text-muted-foreground mt-0.5">{s.totalTrades} trades</div>
                  </div>
                ))}
              </div>
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
                        <td className="p-3 text-right font-mono text-white">{s.dipCatchSuccessRate != null ? `${s.dipCatchSuccessRate.toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {dipTrades.length > 0 && selectedRun && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20">
              <CardTitle className="flex items-center gap-2"><Crosshair className="w-5 h-5 text-accent" />Dip Catch Analytics</CardTitle>
              <CardDescription>Performance of dip-buying signals in Run #{selectedRunId}</CardDescription>
            </CardHeader>
            <CardContent className="p-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Dip Catches</div>
                  <div className="text-2xl font-mono font-bold text-white">{dipTrades.length}</div>
                </div>
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Dip Win Rate</div>
                  <div className={`text-2xl font-mono font-bold ${dipTrades.length > 0 && dipWins / dipTrades.length >= 0.5 ? "text-success" : "text-destructive"}`}>
                    {dipTrades.length > 0 ? `${((dipWins / dipTrades.length) * 100).toFixed(0)}%` : "—"}
                  </div>
                </div>
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Best Dip P&L</div>
                  <div className="text-2xl font-mono font-bold text-success">{bestDip ? `$${bestDip.pnl.toFixed(2)}` : "—"}</div>
                  {bestDip && <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{bestDip.title}</div>}
                </div>
                <div className="p-4 rounded-lg bg-black/30 border border-white/5 text-center">
                  <div className="text-xs text-muted-foreground uppercase mb-1">Worst Dip P&L</div>
                  <div className="text-2xl font-mono font-bold text-destructive">{worstDip ? `$${worstDip.pnl.toFixed(2)}` : "—"}</div>
                  {worstDip && <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{worstDip.title}</div>}
                </div>
              </div>
              <div className="space-y-2">
                {dipTrades.slice(0, 5).map(t => (
                  <div key={t.id} className="flex items-center gap-3 p-2 rounded bg-black/20 border border-white/5">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.outcome === "won" ? "bg-success" : "bg-destructive"}`} />
                    <span className="text-xs text-white truncate flex-1">{t.title}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{t.distanceFromPeak != null ? `${(t.distanceFromPeak * 100).toFixed(1)}% from peak` : ""}</span>
                    <span className={`text-xs font-mono font-bold ${t.pnl >= 0 ? "text-success" : "text-destructive"}`}>${t.pnl.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {trades.length > 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20">
              <CardTitle>Backtest Trades</CardTitle>
              <CardDescription>{trades.length} simulated trades for Run #{selectedRunId} — click a row to expand AI reasoning</CardDescription>
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
                      <th className="text-right p-3 text-muted-foreground font-medium">Edge</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">CLV</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">P&L</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Settled</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Result</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Dip</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {trades.map((t) => <TradeRow key={t.id} trade={t} />)}
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
                          <Button variant="ghost" size="sm" onClick={() => setSelectedRunId(r.id)} className="text-primary hover:text-primary/80">View</Button>
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
