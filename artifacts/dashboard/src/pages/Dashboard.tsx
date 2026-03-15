import { useGetDashboardOverview, useGetPositions } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Activity, ArrowUpRight, ArrowDownRight, Target, Wallet, BarChart3 } from "lucide-react";
import { motion } from "framer-motion";

export default function Dashboard() {
  const { data: overview, isLoading: overviewLoading } = useGetDashboardOverview({
    query: { refetchInterval: 10000 } as object
  });
  
  const { data: positions, isLoading: positionsLoading } = useGetPositions({
    query: { refetchInterval: 10000 } as object
  });

  const isPositive = (val?: number | null) => (val || 0) >= 0;

  const stats = [
    {
      title: "Total Balance",
      value: formatCurrency(overview?.balance),
      icon: Wallet,
      color: "text-blue-400"
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
                    {positions.map((pos) => (
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
      </div>
    </Layout>
  );
}
