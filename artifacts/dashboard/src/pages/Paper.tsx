import { useState, useCallback, Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetDashboardOverview, getGetDashboardOverviewQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { format } from "date-fns";
import {
  FileText, RefreshCw, RotateCcw, TrendingUp, TrendingDown, Wallet,
  Target, Activity, BarChart3, AlertTriangle, Wifi, WifiOff, ExternalLink,
  ChevronDown, ChevronUp, Brain,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, ReferenceLine, Legend,
} from "recharts";

const API_BASE = `${import.meta.env.BASE_URL}api`;

function kalshiUrl(ticker: string): string {
  const lastDash = ticker.lastIndexOf("-");
  const eventTicker = lastDash !== -1 ? ticker.substring(0, lastDash) : ticker;
  return `https://kalshi.com/markets/${eventTicker}/${ticker}`;
}

interface PaperTrade {
  id: number;
  kalshiTicker: string;
  title: string;
  side: string;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  pnl: number | null;
  status: string;
  strategyName: string | null;
  modelProbability: number | null;
  edge: number | null;
  confidence: number | null;
  analystReasoning: string | null;
  closedAt: string | null;
  createdAt: string;
  currentPrice: number | null;
  priceSource: "live" | "entry_fallback" | "settled" | null;
  unrealizedPnl: number | null;
}

interface PaperStats {
  paperBalance: number;
  totalPortfolioValue: number;
  unrealizedPnl: number;
  openPositionValue: number;
  livePricesAvailable: boolean;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

interface EquityPoint {
  date: string;
  portfolioValue: number;
  cashBalance: number;
  pnl: number;
  label: string;
}

interface StrategyRow {
  name: string;
  trades: number;
  wins: number;
  totalEdge: number;
  totalPnl: number;
  invested: number;
  winRate: number;
  avgEdge: number;
  roi: number;
}

interface Bucket {
  bucket: string;
  count: number;
  wins: number;
  winRate: number;
  avgEdge?: number;
}

interface EquityData {
  points: EquityPoint[];
  strategyStats: StrategyRow[];
  edgeBuckets: Bucket[];
  confBuckets: Bucket[];
  startBalance: number;
}

const STRATEGY_COLORS: Record<string, string> = {
  "Pure Value": "#a78bfa",
  "Sharp Money": "#34d399",
  "Contrarian Reversal": "#f59e0b",
  "Momentum": "#60a5fa",
  "Late Efficiency": "#f87171",
};

function usePaperTrades() {
  return useQuery({
    queryKey: ["/api/paper-trades"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades?limit=200`);
      const data = await res.json();
      return (data.trades || data) as PaperTrade[];
    },
    refetchInterval: 20000,
  });
}

function usePaperStats() {
  return useQuery({
    queryKey: ["/api/paper-trades/stats"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades/stats`);
      return res.json() as Promise<PaperStats>;
    },
    refetchInterval: 20000,
  });
}

function useEquityData() {
  return useQuery({
    queryKey: ["/api/paper-trades/equity"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades/equity`);
      return res.json() as Promise<EquityData>;
    },
    refetchInterval: 30000,
  });
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string; payload: EquityPoint }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  return (
    <div className="bg-card/95 border border-white/10 rounded-lg p-3 text-xs shadow-xl backdrop-blur-sm max-w-[260px]">
      <div className="text-muted-foreground mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono font-bold text-white">{formatCurrency(p.value)}</span>
        </div>
      ))}
      {point?.label && (
        <div className="mt-1.5 pt-1.5 border-t border-white/10 text-muted-foreground/80 leading-tight">
          {point.label}
        </div>
      )}
    </div>
  );
}

function WinRateTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card/95 border border-white/10 rounded-lg p-3 text-xs shadow-xl backdrop-blur-sm">
      <div className="text-muted-foreground mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono font-bold text-white">
            {p.name === "Win Rate" ? `${(p.value * 100).toFixed(0)}%` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Paper() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: trades, isLoading } = usePaperTrades();
  const { data: stats } = usePaperStats();
  const { data: equity } = useEquityData();
  const { data: overview } = useGetDashboardOverview({ query: { queryKey: getGetDashboardOverviewQueryKey() } });
  const [filter, setFilter] = useState<"all" | "open" | "won" | "lost">("all");
  const [reconciling, setReconciling] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const handleReconcile = useCallback(async () => {
    setReconciling(true);
    try {
      const res = await fetch(`${API_BASE}/paper-trades/reconcile`, { method: "POST" });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades/equity"] });
      toast({ title: "Reconciliation Complete", description: "Paper trades reconciled against market results." });
    } catch {
      toast({ title: "Error", description: "Failed to reconcile.", variant: "destructive" });
    } finally {
      setReconciling(false);
    }
  }, [queryClient, toast]);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      const res = await fetch(`${API_BASE}/paper-trades/reset`, { method: "POST" });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades/equity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/overview"] });
      toast({ title: "Paper Trading Reset", description: "All paper trades cleared. Balance restored to $5,000." });
    } catch {
      toast({ title: "Error", description: "Failed to reset.", variant: "destructive" });
    } finally {
      setResetting(false);
    }
  }, [queryClient, toast]);

  const allTrades = trades || [];
  const filteredTrades = allTrades.filter((t) => filter === "all" || t.status === filter);
  const openTrades = allTrades.filter(t => t.status === "open");
  const anyLivePrices = openTrades.some(t => t.priceSource === "live");
  const allFallback = openTrades.length > 0 && openTrades.every(t => t.priceSource === "entry_fallback");

  const isPositive = (val?: number | null) => (val || 0) >= 0;
  const isPaperActive = overview?.paperTradingMode;

  const portfolioValue = stats?.totalPortfolioValue ?? stats?.paperBalance ?? 5000;
  const unrealizedPnl = stats?.unrealizedPnl ?? 0;
  const realizedPnl = stats?.totalPnl ?? 0;
  const cashBalance = stats?.paperBalance ?? 5000;

  // Correctly formatted equity points for recharts
  const equityPoints = (equity?.points ?? []).map((p, i) => ({
    ...p,
    date: p.date === "Start" ? "Start" : format(new Date(p.date), i === 1 ? "MMM d" : "MMM d HH:mm"),
  }));

  // Min/max for chart domain with padding
  const equityMin = equityPoints.length > 1
    ? Math.min(...equityPoints.map(p => p.portfolioValue)) - 50
    : 4800;
  const equityMax = equityPoints.length > 1
    ? Math.max(...equityPoints.map(p => p.portfolioValue)) + 50
    : 5200;

  const statCards = [
    {
      title: "Portfolio Value",
      value: formatCurrency(portfolioValue),
      sub: `Cash: ${formatCurrency(cashBalance)}`,
      icon: Wallet,
      color: "text-blue-400",
    },
    {
      title: "Unrealized P&L",
      value: `${unrealizedPnl >= 0 ? "+" : ""}${formatCurrency(unrealizedPnl)}`,
      sub: anyLivePrices ? "live prices" : "using entry price",
      icon: unrealizedPnl >= 0 ? TrendingUp : TrendingDown,
      color: unrealizedPnl >= 0 ? "text-success" : "text-destructive",
    },
    {
      title: "Realized P&L",
      value: `${realizedPnl >= 0 ? "+" : ""}${formatCurrency(realizedPnl)}`,
      sub: `Win rate: ${stats?.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : "—"} (${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L)`,
      icon: Target,
      color: isPositive(realizedPnl) ? "text-success" : "text-destructive",
    },
    {
      title: "Open / Total",
      value: `${stats?.openTrades ?? 0} / ${stats?.totalTrades ?? 0}`,
      sub: `${stats?.closedTrades ?? 0} closed`,
      icon: Activity,
      color: "text-purple-400",
    },
  ];

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-3xl font-bold font-display text-white tracking-tight">Paper Trading</h2>
              {isPaperActive ? (
                <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">ACTIVE</Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">INACTIVE</Badge>
              )}
            </div>
            <p className="text-muted-foreground">Simulated trades with $5,000 virtual balance. No real money at risk.</p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleReconcile} disabled={reconciling} className="gap-2 bg-white/5 border-white/10 hover:bg-white/10">
              {reconciling ? <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> : <RefreshCw className="w-4 h-4" />}
              Reconcile
            </Button>
            <Button variant="outline" onClick={handleReset} disabled={resetting} className="gap-2 bg-white/5 border-white/10 hover:bg-white/10 text-destructive hover:text-destructive">
              {resetting ? <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> : <RotateCcw className="w-4 h-4" />}
              Reset All
            </Button>
          </div>
        </div>

        {allFallback && (
          <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>Live Kalshi prices unavailable — open positions shown at entry price. P&L updates when prices are accessible or trades resolve.</span>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {statCards.map((stat) => (
            <Card key={stat.title} className="overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">{stat.title}</CardTitle>
                <stat.icon className={`w-4 h-4 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-bold font-mono ${stat.color}`}>{stat.value}</div>
                {stat.sub && <div className="text-[11px] text-muted-foreground mt-1">{stat.sub}</div>}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Portfolio Equity Curve — server-computed with correct cash-flow accounting */}
        {equityPoints.length > 1 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20 py-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  Portfolio Value Over Time
                </CardTitle>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>Open positions held at cost-basis</span>
                  <span className={`font-mono font-bold ${realizedPnl >= 0 ? "text-success" : "text-destructive"}`}>
                    Net realized: {realizedPnl >= 0 ? "+" : ""}{formatCurrency(realizedPnl)}
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={equityPoints} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                    <defs>
                      <linearGradient id="portfolioGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="cashGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#34d399" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#34d399" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="date" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v.toLocaleString()}`} domain={[equityMin, equityMax]} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine y={5000} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" label={{ value: "$5,000", fill: "#6b7280", fontSize: 10, position: "right" }} />
                    <Legend wrapperStyle={{ fontSize: 11, color: "#9ca3af" }} />
                    <Area type="stepAfter" dataKey="cashBalance" name="Cash" stroke="#34d399" strokeWidth={1.5} fill="url(#cashGrad)" dot={false} strokeDasharray="4 3" />
                    <Area type="stepAfter" dataKey="portfolioValue" name="Portfolio" stroke="#a78bfa" strokeWidth={2} fill="url(#portfolioGrad)" dot={false} activeDot={{ r: 4, fill: "#a78bfa" }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Analytics row: Edge calibration + Confidence calibration */}
        {equity && (equity.edgeBuckets.length > 0 || equity.confBuckets.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Edge → Win Rate calibration */}
            {equity.edgeBuckets.length > 0 && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-primary" />
                    Edge vs Actual Win Rate
                    <span className="text-xs text-muted-foreground font-normal ml-1">— is higher edge actually winning more?</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="h-44">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={equity.edgeBuckets} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="bucket" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
                        <Tooltip content={<WinRateTooltip />} />
                        <ReferenceLine y={0.5} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
                        <Bar dataKey="winRate" name="Win Rate" radius={[4, 4, 0, 0]} maxBarSize={48}>
                          {equity.edgeBuckets.map((b) => (
                            <Cell key={b.bucket} fill={b.winRate >= 0.5 ? "#34d399" : "#f87171"} fillOpacity={0.8} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {equity.edgeBuckets.map((b) => (
                      <div key={b.bucket} className="text-center text-[10px] text-muted-foreground">
                        <div className="font-mono text-white">{b.bucket}</div>
                        <div>{b.wins}/{b.count} wins</div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Confidence → Win Rate calibration */}
            {equity.confBuckets.length > 0 && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Brain className="w-4 h-4 text-purple-400" />
                    AI Confidence vs Actual Win Rate
                    <span className="text-xs text-muted-foreground font-normal ml-1">— is the AI calibrated?</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="h-44">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={equity.confBuckets} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="bucket" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
                        <Tooltip content={<WinRateTooltip />} />
                        <ReferenceLine y={0.5} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
                        <Bar dataKey="winRate" name="Win Rate" radius={[4, 4, 0, 0]} maxBarSize={48}>
                          {equity.confBuckets.map((b) => (
                            <Cell key={b.bucket} fill={b.winRate >= 0.5 ? "#a78bfa" : "#f87171"} fillOpacity={0.8} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {equity.confBuckets.map((b) => (
                      <div key={b.bucket} className="text-center text-[10px] text-muted-foreground">
                        <div className="font-mono text-white">{b.bucket}</div>
                        <div>{b.wins}/{b.count} wins</div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Strategy Performance table */}
        {equity && equity.strategyStats.length > 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20 py-3">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-primary" />
                Strategy Performance
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] text-muted-foreground uppercase bg-white/[0.02]">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold">Strategy</th>
                      <th className="px-4 py-3 text-right font-semibold">Trades</th>
                      <th className="px-4 py-3 text-right font-semibold">Win Rate</th>
                      <th className="px-4 py-3 text-right font-semibold">Avg Edge</th>
                      <th className="px-4 py-3 text-right font-semibold">Invested</th>
                      <th className="px-4 py-3 text-right font-semibold">Realized P&L</th>
                      <th className="px-4 py-3 text-right font-semibold">ROI</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {equity.strategyStats.map((s) => (
                      <tr key={s.name} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: STRATEGY_COLORS[s.name] || "#6b7280" }} />
                            <span className="font-medium text-white">{s.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-right text-muted-foreground">{s.trades}</td>
                        <td className="px-4 py-3 font-mono text-right">
                          {s.wins + (s.trades - s.wins) > 0
                            ? <span className={s.winRate >= 0.5 ? "text-success" : s.winRate === 0 ? "text-muted-foreground" : "text-destructive"}>
                              {(s.winRate * 100).toFixed(0)}%
                              <span className="text-muted-foreground ml-1 text-[10px]">({s.wins}W)</span>
                            </span>
                            : <span className="text-muted-foreground">—</span>
                          }
                        </td>
                        <td className="px-4 py-3 font-mono text-right text-primary">{s.avgEdge.toFixed(1)}%</td>
                        <td className="px-4 py-3 font-mono text-right text-muted-foreground">{formatCurrency(s.invested)}</td>
                        <td className={`px-4 py-3 font-mono font-bold text-right ${s.totalPnl >= 0 ? "text-success" : "text-destructive"}`}>
                          {s.totalPnl >= 0 ? "+" : ""}{formatCurrency(s.totalPnl)}
                        </td>
                        <td className={`px-4 py-3 font-mono font-bold text-right ${s.roi >= 0 ? "text-success" : "text-destructive"}`}>
                          {s.roi >= 0 ? "+" : ""}{(s.roi * 100).toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Open Positions */}
        {openTrades.length > 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20 py-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="w-4 h-4 text-yellow-400" />
                Open Positions ({openTrades.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-white/5">
                {openTrades.map((t) => {
                  const cost = t.entryPrice * t.quantity;
                  const livePrice = t.currentPrice ?? t.entryPrice;
                  const unrealized = t.unrealizedPnl ?? (livePrice * t.quantity - cost);
                  const isLive = t.priceSource === "live";
                  return (
                    <div key={t.id} className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-white truncate">{t.title}</div>
                          <a
                            href={kalshiUrl(t.kalshiTicker)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 mt-0.5 w-fit"
                          >
                            {t.kalshiTicker}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className={`text-sm font-mono font-bold ${unrealized >= 0 ? "text-success" : "text-destructive"}`}>
                            {unrealized >= 0 ? "+" : ""}{formatCurrency(unrealized)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">unrealized</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground flex-wrap">
                        <Badge variant={t.side === "yes" ? "success" : "destructive"} className="text-[10px] h-4">{t.side.toUpperCase()}</Badge>
                        <span className="font-mono">{t.quantity} @ {formatCurrency(t.entryPrice)}</span>
                        <span className="flex items-center gap-1">
                          {isLive ? <Wifi className="w-2.5 h-2.5 text-success" /> : <WifiOff className="w-2.5 h-2.5 text-yellow-400" />}
                          <span className="text-muted-foreground/60">Mark:</span>
                          <span className={`font-mono ${isLive ? "text-white" : "text-yellow-400"}`}>{formatCurrency(livePrice)}</span>
                          {!isLive && <span className="text-yellow-400/70">(entry)</span>}
                        </span>
                        <span>Cost: {formatCurrency(cost)}</span>
                        {t.edge != null && <span className="text-primary">{t.edge.toFixed(1)}% edge</span>}
                        {t.strategyName && <span className="text-muted-foreground/60">{t.strategyName}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Full Trade Log */}
        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20 flex flex-row items-center justify-between py-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="w-5 h-5 text-yellow-400" />
              Paper Trade Log
            </CardTitle>
            <div className="flex bg-black/40 p-1 rounded-lg border border-white/5">
              {(["all", "open", "won", "lost"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${filter === f ? "bg-white/10 text-white" : "text-muted-foreground hover:text-white"}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading paper trades...</div>
            ) : filteredTrades.length === 0 ? (
              <div className="p-16 text-center flex flex-col items-center">
                <FileText className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-medium text-white">No paper trades</h3>
                <p className="text-muted-foreground mt-1">
                  {isPaperActive ? "The pipeline is running in paper mode. Trades will appear here." : "Enable paper trading in Settings."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-white/[0.02]">
                    <tr>
                      <th className="px-4 py-4 font-semibold">Date</th>
                      <th className="px-4 py-4 font-semibold">Market</th>
                      <th className="px-4 py-4 font-semibold">Strategy</th>
                      <th className="px-4 py-4 font-semibold">Side / Qty</th>
                      <th className="px-4 py-4 font-semibold text-right">Entry</th>
                      <th className="px-4 py-4 font-semibold text-right">Edge / Conf</th>
                      <th className="px-4 py-4 font-semibold text-right">Mark / Exit</th>
                      <th className="px-4 py-4 font-semibold text-right">P&L</th>
                      <th className="px-4 py-4 font-semibold text-center">Status</th>
                      <th className="px-4 py-4 font-semibold text-center">AI</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredTrades.map((trade) => {
                      const livePrice = trade.currentPrice ?? trade.entryPrice;
                      const isLive = trade.priceSource === "live";
                      const displayPnl = trade.status === "open" ? (trade.unrealizedPnl ?? null) : trade.pnl;
                      const isExpanded = expandedId === trade.id;
                      return (
                        <Fragment key={trade.id}>
                          <tr className="hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 whitespace-nowrap text-muted-foreground text-xs">
                              {format(new Date(trade.createdAt), "MMM d, HH:mm")}
                            </td>
                            <td className="px-4 py-3 max-w-[180px]">
                              <div className="text-xs font-medium text-white truncate" title={trade.title}>{trade.title}</div>
                              <a href={kalshiUrl(trade.kalshiTicker)} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] font-mono text-muted-foreground hover:text-primary flex items-center gap-1 w-fit">
                                {trade.kalshiTicker.slice(0, 22)}{trade.kalshiTicker.length > 22 ? "…" : ""}
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            </td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                              {trade.strategyName ?? "—"}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1.5">
                                <Badge variant={trade.side === "yes" ? "success" : "destructive"} className="text-[10px] h-4">{trade.side.toUpperCase()}</Badge>
                                <span className="text-xs font-mono text-muted-foreground">{trade.quantity}ct</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 font-mono text-right text-xs text-white">
                              {formatCurrency(trade.entryPrice)}
                            </td>
                            <td className="px-4 py-3 text-right text-xs">
                              {trade.edge != null && (
                                <div className="text-primary font-mono">{trade.edge.toFixed(1)}%</div>
                              )}
                              {trade.confidence != null && (
                                <div className="text-muted-foreground text-[10px]">{(trade.confidence * 100).toFixed(0)}% conf</div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right text-xs">
                              <div className="flex flex-col items-end gap-0.5">
                                {trade.status === "open" ? (
                                  <div className="flex items-center gap-1">
                                    {isLive ? <Wifi className="w-2.5 h-2.5 text-success" /> : <WifiOff className="w-2.5 h-2.5 text-yellow-400" />}
                                    <span className={`font-mono ${isLive ? "text-white" : "text-yellow-400"}`}>{formatCurrency(livePrice)}</span>
                                  </div>
                                ) : (
                                  <span className="font-mono text-muted-foreground">{formatCurrency(trade.exitPrice ?? 0)}</span>
                                )}
                                {trade.closedAt && (
                                  <span className="text-[9px] text-muted-foreground/60">{format(new Date(trade.closedAt), "MMM d")}</span>
                                )}
                              </div>
                            </td>
                            <td className={`px-4 py-3 font-mono font-bold text-right text-xs ${displayPnl != null ? (displayPnl >= 0 ? "text-success" : "text-destructive") : "text-muted-foreground"}`}>
                              {displayPnl != null ? `${displayPnl >= 0 ? "+" : ""}${formatCurrency(displayPnl)}` : "—"}
                              {trade.status === "open" && displayPnl != null && <div className="text-[9px] font-normal text-muted-foreground">unrealized</div>}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <Badge
                                variant={trade.status === "won" ? "success" : trade.status === "lost" ? "destructive" : trade.status === "open" ? "default" : "outline"}
                                className="text-[10px]"
                              >
                                {trade.status}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {trade.analystReasoning ? (
                                <button
                                  onClick={() => setExpandedId(isExpanded ? null : trade.id)}
                                  className={`transition-colors ${isExpanded ? "text-accent" : "text-muted-foreground hover:text-primary"}`}
                                  title="View AI reasoning"
                                >
                                  {isExpanded ? <ChevronUp className="w-4 h-4 mx-auto" /> : <ChevronDown className="w-4 h-4 mx-auto" />}
                                </button>
                              ) : <span className="text-muted-foreground/30">—</span>}
                            </td>
                          </tr>
                          {isExpanded && trade.analystReasoning && (
                            <tr>
                              <td colSpan={10} className="px-6 pb-4 pt-0 bg-black/20">
                                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-muted-foreground leading-relaxed">
                                  <div className="flex items-center gap-1.5 text-purple-400 font-medium mb-2">
                                    <Brain className="w-3.5 h-3.5" />
                                    AI Reasoning
                                  </div>
                                  <p>{trade.analystReasoning}</p>
                                  {trade.modelProbability != null && (
                                    <div className="flex gap-6 mt-3 pt-2 border-t border-white/5 text-[10px]">
                                      <span>Model prob: <span className="text-white font-mono">{(trade.modelProbability * 100).toFixed(1)}%</span></span>
                                      {trade.edge != null && <span>Edge: <span className="text-primary font-mono">{trade.edge.toFixed(1)}%</span></span>}
                                      {trade.confidence != null && <span>Confidence: <span className="text-white font-mono">{(trade.confidence * 100).toFixed(0)}%</span></span>}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
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
