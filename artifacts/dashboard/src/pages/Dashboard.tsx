import { useQuery } from "@tanstack/react-query";
import { useGetDashboardOverview, useGetPositions, getGetDashboardOverviewQueryKey, getGetPositionsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Activity, ArrowUpRight, ArrowDownRight, Target, Wallet, BarChart3, FileText } from "lucide-react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { Link } from "wouter";

const API_BASE = `${import.meta.env.BASE_URL}api`;

interface RecentPaperRow {
  id: number;
  kalshiTicker: string;
  title: string;
  side: string;
  entryPrice: number;
  quantity: number;
  status: string;
  strategyName: string | null;
  edge: number | null;
  createdAt: string;
}

export default function Dashboard() {
  const { data: overview, isLoading: overviewLoading } = useGetDashboardOverview({
    query: { queryKey: getGetDashboardOverviewQueryKey(), refetchInterval: 10000 }
  });
  
  const { data: positions, isLoading: positionsLoading } = useGetPositions({
    query: { queryKey: getGetPositionsQueryKey(), refetchInterval: 10000 }
  });

  const { data: recentPaper, isLoading: paperLoading } = useQuery({
    queryKey: ["dashboard-recent-paper"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades?limit=12&enrichLive=1`);
      const data = await res.json();
      return (data.trades || []) as RecentPaperRow[];
    },
    refetchInterval: 15000,
  });

  const positionList = Array.isArray(positions) ? positions : [];

  const isPositive = (val?: number | null) => (val || 0) >= 0;

  const stats = [
    {
      title: "Total Balance",
      value: overview?.balanceError ? "Unavailable" : formatCurrency(overview?.balance),
      icon: Wallet,
      color: overview?.balanceError ? "text-destructive" : "text-blue-400"
    },
    {
      title: "Today's P&L",
      value: formatCurrency(overview?.todayPnl),
      icon: Activity,
      color: isPositive(overview?.todayPnl) ? "text-success" : "text-destructive",
      trend: isPositive(overview?.todayPnl) ? ArrowUpRight : ArrowDownRight
    },
    {
      title: "Total P&L",
      value: formatCurrency(overview?.totalPnl),
      icon: BarChart3,
      color: isPositive(overview?.totalPnl) ? "text-success" : "text-destructive",
      trend: isPositive(overview?.totalPnl) ? ArrowUpRight : ArrowDownRight
    },
    {
      title: "Win Rate",
      value: formatPercent(overview?.winRate),
      icon: Target,
      color: "text-accent"
    }
  ];

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Welcome Section */}
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight">Overview</h2>
            <p className="text-muted-foreground mt-1">Real-time performance of your automated trading pipeline.</p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {stats.map((stat, i) => (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              key={stat.title}
            >
              <Card className="overflow-hidden">
                <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                  <CardTitle className="text-sm font-medium text-muted-foreground">{stat.title}</CardTitle>
                  <stat.icon className={`w-4 h-4 ${stat.color}`} />
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <div className="text-3xl font-bold font-mono text-white">
                      {overviewLoading ? "..." : stat.value}
                    </div>
                    {stat.trend && !overviewLoading && (
                      <stat.trend className={`w-5 h-5 ${stat.color} opacity-80`} />
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Open Positions */}
        <Card className="border-white/10 glass-panel">
          <CardHeader className="border-b border-white/5 bg-black/20">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">Open Positions ({overview?.openPositions || 0})</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {positionsLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading positions...</div>
            ) : !positions || positions.length === 0 ? (
              <div className="p-12 text-center flex flex-col items-center justify-center">
                <Activity className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-medium text-white">No open positions</h3>
                <p className="text-muted-foreground mt-1">The system is waiting for the next opportunity.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-white/[0.02]">
                    <tr>
                      <th className="px-6 py-4 font-semibold rounded-tl-lg">Market</th>
                      <th className="px-6 py-4 font-semibold">Side</th>
                      <th className="px-6 py-4 font-semibold text-right">Size</th>
                      <th className="px-6 py-4 font-semibold text-right">Avg Price</th>
                      <th className="px-6 py-4 font-semibold text-right">Current</th>
                      <th className="px-6 py-4 font-semibold text-right rounded-tr-lg">Unrealized P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {positionList.map((pos) => (
                      <tr key={pos.ticker} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-medium text-white mb-1">{pos.title}</div>
                          <div className="text-xs font-mono text-muted-foreground">{pos.ticker}</div>
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant={pos.side === 'yes' ? 'success' : 'destructive'} className="uppercase">
                            {pos.side}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 font-mono text-right text-white">
                          {pos.quantity}
                        </td>
                        <td className="px-6 py-4 font-mono text-right text-muted-foreground">
                          {formatCurrency(pos.avgPrice)}
                        </td>
                        <td className="px-6 py-4 font-mono text-right text-white">
                          {formatCurrency(pos.currentPrice)}
                        </td>
                        <td className={`px-6 py-4 font-mono font-bold text-right ${isPositive(pos.unrealizedPnl) ? 'text-success' : 'text-destructive'}`}>
                          {isPositive(pos.unrealizedPnl) ? '+' : ''}{formatCurrency(pos.unrealizedPnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent paper trades (keeper strategies) */}
        <Card className="border-white/10 glass-panel">
          <CardHeader className="border-b border-white/5 bg-black/20">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl flex items-center gap-2">
                <FileText className="w-5 h-5 text-muted-foreground" />
                Recent paper trades
              </CardTitle>
              <Link href="/paper" className="text-sm text-accent hover:underline">
                Open Paper →
              </Link>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Live ASK taker fills · rule-based keepers only
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {paperLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading trades...</div>
            ) : !recentPaper?.length ? (
              <div className="p-10 text-center text-muted-foreground">
                No paper trades yet. After the next pipeline cycle, executions appear here.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-white/[0.02]">
                    <tr>
                      <th className="px-6 py-3 font-semibold">Time</th>
                      <th className="px-6 py-3 font-semibold">Market</th>
                      <th className="px-6 py-3 font-semibold">Strategy</th>
                      <th className="px-6 py-3 font-semibold">Side</th>
                      <th className="px-6 py-3 font-semibold text-right">ASK / Size</th>
                      <th className="px-6 py-3 font-semibold text-right">Edge</th>
                      <th className="px-6 py-3 font-semibold rounded-tr-lg">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {recentPaper.map((t) => (
                      <tr key={t.id} className="hover:bg-white/[0.02]">
                        <td className="px-6 py-3 font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(t.createdAt), "MMM d HH:mm")}
                        </td>
                        <td className="px-6 py-3 max-w-[220px]">
                          <div className="font-medium text-white truncate" title={t.title}>{t.title}</div>
                          <div className="text-xs font-mono text-muted-foreground truncate">{t.kalshiTicker}</div>
                        </td>
                        <td className="px-6 py-3 text-muted-foreground">{t.strategyName ?? "—"}</td>
                        <td className="px-6 py-3">
                          <Badge variant={t.side === "yes" ? "success" : "destructive"} className="uppercase">
                            {t.side}
                          </Badge>
                        </td>
                        <td className="px-6 py-3 font-mono text-right text-white">
                          {formatCurrency(t.entryPrice)} × {t.quantity}
                        </td>
                        <td className="px-6 py-3 font-mono text-right text-muted-foreground">
                          {t.edge != null ? `${t.edge.toFixed(1)}pp` : "—"}
                        </td>
                        <td className="px-6 py-3">
                          <Badge variant="outline" className="capitalize">{t.status}</Badge>
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
