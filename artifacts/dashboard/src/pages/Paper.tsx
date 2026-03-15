import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetDashboardOverview, getGetDashboardOverviewQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";
import { FileText, RefreshCw, RotateCcw, TrendingUp, TrendingDown, Wallet, Target, Activity, BarChart3 } from "lucide-react";

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
  closedAt: string | null;
  createdAt: string;
  clv?: number | null;
}

interface PaperStats {
  paperBalance: number;
  totalTrades: number;
  openTrades: number;
  winRate: number;
  totalPnl: number;
}

function usePaperTrades() {
  return useQuery({
    queryKey: ["/api/paper-trades"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades?limit=100`);
      const data = await res.json();
      return (data.trades || data) as PaperTrade[];
    },
    refetchInterval: 10000,
  });
}

function usePaperStats() {
  return useQuery({
    queryKey: ["/api/paper-trades/stats"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades/stats`);
      return res.json() as Promise<PaperStats>;
    },
    refetchInterval: 10000,
  });
}

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
      toast({ title: "Reconciliation Complete", description: "Paper trades have been reconciled against market results." });
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

  const filteredTrades = (trades || []).filter((t) => {
    if (filter === "all") return true;
    return t.status === filter;
  });

  const isPositive = (val?: number | null) => (val || 0) >= 0;
  const isPaperActive = overview?.paperTradingMode;

  const statCards = [
    {
      title: "Paper Balance",
      value: formatCurrency(stats?.paperBalance ?? 5000),
      icon: Wallet,
      color: "text-blue-400",
    },
    {
      title: "Total P&L",
      value: formatCurrency(stats?.totalPnl ?? 0),
      icon: isPositive(stats?.totalPnl) ? TrendingUp : TrendingDown,
      color: isPositive(stats?.totalPnl) ? "text-success" : "text-destructive",
    },
    {
      title: "Win Rate",
      value: stats?.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : "—",
      icon: Target,
      color: "text-accent",
    },
    {
      title: "Open / Total",
      value: `${stats?.openTrades ?? 0} / ${stats?.totalTrades ?? 0}`,
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
            <Button
              variant="outline"
              onClick={handleReconcile}
              disabled={reconciling}
              className="gap-2 bg-white/5 border-white/10 hover:bg-white/10"
            >
              {reconciling ? <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> : <RefreshCw className="w-4 h-4" />}
              Reconcile
            </Button>
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="gap-2 bg-white/5 border-white/10 hover:bg-white/10 text-destructive hover:text-destructive"
            >
              {resetting ? <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> : <RotateCcw className="w-4 h-4" />}
              Reset All
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {statCards.map((stat, i) => (
            <Card key={stat.title} className="overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">{stat.title}</CardTitle>
                <stat.icon className={`w-4 h-4 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono text-white">{stat.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20 flex flex-row items-center justify-between py-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="w-5 h-5 text-yellow-400" />
              Paper Trade Log
            </CardTitle>
            <div className="flex bg-black/40 p-1 rounded-lg border border-white/5">
              {(["all", "open", "won", "lost"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                    filter === f ? "bg-white/10 text-white" : "text-muted-foreground hover:text-white"
                  }`}
                >
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
                  {isPaperActive
                    ? "The pipeline is running in paper mode. Trades will appear here."
                    : "Enable paper trading in Settings to start simulating."}
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
                      <th className="px-6 py-4 font-semibold text-right">Exit</th>
                      <th className="px-6 py-4 font-semibold text-right">P&L</th>
                      <th className="px-6 py-4 font-semibold text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredTrades.map((trade) => (
                      <tr key={trade.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap text-muted-foreground text-xs">
                          {format(new Date(trade.createdAt), "MMM d, HH:mm")}
                        </td>
                        <td className="px-6 py-4 max-w-[250px]">
                          <div className="font-medium text-white mb-1 truncate" title={trade.title}>{trade.title}</div>
                          <div className="text-[10px] font-mono text-muted-foreground">{trade.kalshiTicker}</div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-xs text-muted-foreground">{trade.strategyName || "—"}</span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={trade.side === "yes" ? "success" : "destructive"} className="text-[10px] h-4">
                              {trade.side.toUpperCase()}
                            </Badge>
                          </div>
                          <div className="text-xs font-mono text-muted-foreground">{trade.quantity} cont.</div>
                        </td>
                        <td className="px-6 py-4 font-mono text-right text-white">
                          {formatCurrency(trade.entryPrice)}
                        </td>
                        <td className="px-6 py-4 font-mono text-right text-muted-foreground">
                          {trade.exitPrice != null ? formatCurrency(trade.exitPrice) : "—"}
                        </td>
                        <td className={`px-6 py-4 font-mono font-bold text-right ${trade.pnl != null ? (isPositive(trade.pnl) ? "text-success" : "text-destructive") : "text-muted-foreground"}`}>
                          {trade.pnl != null ? `${isPositive(trade.pnl) ? "+" : ""}${formatCurrency(trade.pnl)}` : "—"}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <Badge variant={
                            trade.status === "won" ? "success" :
                            trade.status === "lost" ? "destructive" :
                            trade.status === "open" ? "default" : "outline"
                          }>
                            {trade.status}
                          </Badge>
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
