import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetDashboardOverview, getGetDashboardOverviewQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { format } from "date-fns";
import { FileText, RefreshCw, RotateCcw, TrendingUp, TrendingDown, Wallet, Target, Activity, BarChart3, AlertTriangle, Wifi, WifiOff } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell
} from "recharts";

const API_BASE = `${import.meta.env.BASE_URL}api`;

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

function usePaperTrades() {
  return useQuery({
    queryKey: ["/api/paper-trades"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades?limit=200`);
      const data = await res.json();
      return (data.trades || data) as PaperTrade[];
    },
    refetchInterval: 15000,
  });
}

function usePaperStats() {
  return useQuery({
    queryKey: ["/api/paper-trades/stats"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades/stats`);
      return res.json() as Promise<PaperStats>;
    },
    refetchInterval: 15000,
  });
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card/95 border border-white/10 rounded-lg p-3 text-xs shadow-xl backdrop-blur-sm">
      <div className="text-muted-foreground mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono font-bold text-white">{typeof p.value === "number" ? formatCurrency(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

const STRATEGY_COLORS: Record<string, string> = {
  "Pure Value": "#a78bfa",
  "Dip Buyer": "#34d399",
  "Fade the Public": "#f59e0b",
  "Momentum": "#60a5fa",
  "Late Efficiency": "#f87171",
};

export default function Paper() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: trades, isLoading } = usePaperTrades();
  const { data: stats } = usePaperStats();
  const { data: overview } = useGetDashboardOverview({ query: { queryKey: getGetDashboardOverviewQueryKey() } });
  const [filter, setFilter] = useState<"all" | "open" | "won" | "lost">("all");
  const [reconciling, setReconciling] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleReconcile = useCallback(async () => {
    setReconciling(true);
    try {
      const res = await fetch(`${API_BASE}/paper-trades/reconcile`, { method: "POST" });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/paper-trades/stats"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/overview"] });
      toast({ title: "Paper Trading Reset", description: "All paper trades cleared. Balance restored to $5,000." });
    } catch {
      toast({ title: "Error", description: "Failed to reset.", variant: "destructive" });
    } finally {
      setResetting(false);
    }
  }, [queryClient, toast]);

  const allTrades = trades || [];
  const filteredTrades = allTrades.filter((t) => {
    if (filter === "all") return true;
    return t.status === filter;
  });

  const openTrades = allTrades.filter(t => t.status === "open");
  const anyLivePrices = openTrades.some(t => t.priceSource === "live");
  const allFallback = openTrades.length > 0 && openTrades.every(t => t.priceSource === "entry_fallback");

  const isPositive = (val?: number | null) => (val || 0) >= 0;
  const isPaperActive = overview?.paperTradingMode;

  const portfolioValue = stats?.totalPortfolioValue ?? stats?.paperBalance ?? 5000;
  const unrealizedPnl = stats?.unrealizedPnl ?? 0;
  const realizedPnl = stats?.totalPnl ?? 0;
  const cashBalance = stats?.paperBalance ?? 5000;

  const pnlTimeline = useMemo(() => {
    const sorted = [...allTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let cash = 5000;
    const points: { date: string; portfolio: number; pnl: number }[] = [{ date: "Start", portfolio: 5000, pnl: 0 }];
    for (const t of sorted) {
      const cost = t.entryPrice * t.quantity;
      if (t.status === "open") {
        cash -= cost;
      } else if (t.pnl != null) {
        cash += t.pnl + cost;
      }
      const openVal = openTrades
        .filter(o => o.id <= t.id)
        .reduce((s, o) => s + (o.currentPrice ?? o.entryPrice) * o.quantity, 0);
      const portfolioPoint = cash + openVal;
      points.push({
        date: format(new Date(t.createdAt), "MMM d HH:mm"),
        portfolio: Math.round(portfolioPoint * 100) / 100,
        pnl: Math.round((portfolioPoint - 5000) * 100) / 100,
      });
    }
    return points;
  }, [allTrades, openTrades]);

  const strategyBreakdown = useMemo(() => {
    const map = new Map<string, { name: string; count: number; invested: number; pnl: number; wins: number; unrealized: number }>();
    for (const t of allTrades) {
      const key = t.strategyName || "Unknown";
      if (!map.has(key)) map.set(key, { name: key, count: 0, invested: 0, pnl: 0, wins: 0, unrealized: 0 });
      const s = map.get(key)!;
      s.count++;
      s.invested += t.entryPrice * t.quantity;
      if (t.pnl != null) s.pnl += t.pnl;
      if (t.unrealizedPnl != null) s.unrealized += t.unrealizedPnl;
      if (t.status === "won") s.wins++;
    }
    return Array.from(map.values());
  }, [allTrades]);

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
      sub: stats?.livePricesAvailable === false ? "⚠ using entry price" : anyLivePrices ? "live prices" : "—",
      icon: unrealizedPnl >= 0 ? TrendingUp : TrendingDown,
      color: unrealizedPnl >= 0 ? "text-success" : "text-destructive",
    },
    {
      title: "Realized P&L",
      value: `${realizedPnl >= 0 ? "+" : ""}${formatCurrency(realizedPnl)}`,
      sub: `Win rate: ${stats?.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : "—"}`,
      icon: Target,
      color: isPositive(realizedPnl) ? "text-success" : "text-destructive",
    },
    {
      title: "Open / Total",
      value: `${stats?.openTrades ?? 0} / ${stats?.totalTrades ?? 0}`,
      sub: `${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L closed`,
      icon: Activity,
      color: "text-purple-400",
    },
  ];

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
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
            <span>Live Kalshi prices unavailable — showing entry price as current mark. P&L will update when prices are accessible.</span>
          </div>
        )}

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

        {pnlTimeline.length > 1 && (
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20 py-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  Portfolio Value Over Time
                </CardTitle>
                <div className="flex items-center gap-4 text-xs">
                  <span className={`font-mono font-bold flex items-center gap-1 ${unrealizedPnl >= 0 ? "text-success" : "text-destructive"}`}>
                    {anyLivePrices ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3 text-yellow-400" />}
                    Unrealized: {unrealizedPnl >= 0 ? "+" : ""}{formatCurrency(unrealizedPnl)}
                  </span>
                  <span className={`font-mono font-bold ${realizedPnl >= 0 ? "text-success" : "text-destructive"}`}>
                    Realized P&L: {realizedPnl >= 0 ? "+" : ""}{formatCurrency(realizedPnl)}
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={pnlTimeline} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                    <defs>
                      <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="date" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v.toLocaleString()}`} domain={["auto", "auto"]} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="portfolio" name="Portfolio" stroke="#a78bfa" strokeWidth={2} fill="url(#portfolioGradient)" dot={false} activeDot={{ r: 4, fill: "#a78bfa" }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                            <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{t.kalshiTicker}</div>
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
                            {isLive
                              ? <Wifi className="w-2.5 h-2.5 text-success" />
                              : <WifiOff className="w-2.5 h-2.5 text-yellow-400" />
                            }
                            <span className="text-muted-foreground/60">Mark:</span>
                            <span className={`font-mono ${isLive ? "text-white" : "text-yellow-400"}`}>{formatCurrency(livePrice)}</span>
                            {!isLive && <span className="text-yellow-400/70">(entry)</span>}
                          </span>
                          <span>Cost: {formatCurrency(cost)}</span>
                          {t.edge != null && <span className="text-primary">{t.edge.toFixed(1)}% edge</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {strategyBreakdown.length > 0 && (
            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-primary" />
                  Per-Strategy Performance
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="h-40 mb-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={strategyBreakdown} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(s) => s.split(" ")[0]} />
                      <YAxis tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="invested" name="Invested" radius={[3, 3, 0, 0]} maxBarSize={40}>
                        {strategyBreakdown.map((s) => (
                          <Cell key={s.name} fill={STRATEGY_COLORS[s.name] || "#6b7280"} fillOpacity={0.8} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2">
                  {strategyBreakdown.map((s) => {
                    const totalReturn = s.pnl + s.unrealized;
                    return (
                      <div key={s.name} className="flex items-center gap-2 text-xs">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: STRATEGY_COLORS[s.name] || "#6b7280" }} />
                        <span className="text-white font-medium flex-1 truncate">{s.name}</span>
                        <span className="text-muted-foreground font-mono">{s.count} trades</span>
                        <span className="text-muted-foreground font-mono">{formatCurrency(s.invested)}</span>
                        <span className={`font-mono font-bold ${totalReturn >= 0 ? "text-success" : "text-destructive"}`}>
                          {s.pnl !== 0 || s.unrealized !== 0
                            ? `${totalReturn >= 0 ? "+" : ""}${formatCurrency(totalReturn)}`
                            : "open"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

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
                  {isPaperActive ? "The pipeline is running in paper mode. Trades will appear here." : "Enable paper trading in Settings to start simulating."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-white/[0.02]">
                    <tr>
                      <th className="px-6 py-4 font-semibold">Date</th>
                      <th className="px-6 py-4 font-semibold">Market</th>
                      <th className="px-6 py-4 font-semibold">Strategy</th>
                      <th className="px-6 py-4 font-semibold">Side / Qty</th>
                      <th className="px-6 py-4 font-semibold text-right">Entry</th>
                      <th className="px-6 py-4 font-semibold text-right">Mark / Exit</th>
                      <th className="px-6 py-4 font-semibold text-right">P&L</th>
                      <th className="px-6 py-4 font-semibold text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredTrades.map((trade) => {
                      const livePrice = trade.currentPrice ?? trade.entryPrice;
                      const isLive = trade.priceSource === "live";
                      const displayPnl = trade.status === "open"
                        ? (trade.unrealizedPnl ?? null)
                        : trade.pnl;
                      return (
                        <tr key={trade.id} className="hover:bg-white/[0.02] transition-colors group" title={trade.analystReasoning || undefined}>
                          <td className="px-6 py-4 whitespace-nowrap text-muted-foreground text-xs">{format(new Date(trade.createdAt), "MMM d, HH:mm")}</td>
                          <td className="px-6 py-4 max-w-[250px]">
                            <div className="font-medium text-white mb-1 truncate" title={trade.title}>{trade.title}</div>
                            <div className="text-[10px] font-mono text-muted-foreground">{trade.kalshiTicker}</div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-xs text-muted-foreground">{trade.strategyName || "—"}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant={trade.side === "yes" ? "success" : "destructive"} className="text-[10px] h-4">{trade.side.toUpperCase()}</Badge>
                            </div>
                            <div className="text-xs font-mono text-muted-foreground">{trade.quantity} cont.</div>
                          </td>
                          <td className="px-6 py-4 font-mono text-right text-white">{formatCurrency(trade.entryPrice)}</td>
                          <td className="px-6 py-4 font-mono text-right">
                            {trade.status === "open" ? (
                              <span className={`flex items-center justify-end gap-1 ${isLive ? "text-white" : "text-yellow-400"}`}>
                                {isLive ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                                {formatCurrency(livePrice)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">{trade.exitPrice != null ? formatCurrency(trade.exitPrice) : "—"}</span>
                            )}
                          </td>
                          <td className={`px-6 py-4 font-mono font-bold text-right ${displayPnl != null ? (isPositive(displayPnl) ? "text-success" : "text-destructive") : "text-muted-foreground"}`}>
                            {displayPnl != null ? `${isPositive(displayPnl) ? "+" : ""}${formatCurrency(displayPnl)}` : "—"}
                          </td>
                          <td className="px-6 py-4 text-center">
                            <Badge variant={trade.status === "won" ? "success" : trade.status === "lost" ? "destructive" : trade.status === "open" ? "default" : "outline"}>
                              {trade.status}
                            </Badge>
                          </td>
                        </tr>
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
