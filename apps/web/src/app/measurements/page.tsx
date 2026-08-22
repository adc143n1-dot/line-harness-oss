'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Header from '@/components/layout/header';

type MeasurementRow = {
  accountId: string;
  name: string;
  lpClicks: number;
  lineFriends: number;
  lineAddRate: number | null;
  surveyDone: number;
  surveyTotal: number;
  surveyCompletionRate: number;
  dialCount: number;
  dialPushCount: number;
  dialPushRate: number | null;
  smsSentCount: number;
  smsDeliveredCount: number;
  smsDeliveredRate: number | null;
};

export default function MeasurementsPage() {
  const [rows, setRows] = useState<MeasurementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    const res = await api.measurements.get();
    if (res.success) setRows(res.data as MeasurementRow[]);
    else setError('計測データの取得に失敗しました');
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const pct = (v: number | null) => (v === null ? '-' : `${v}%`);

  return (
    <div>
      <Header
        title="計測データ"
        description="URLクリック率・LINE追加率・アンケート完了率・ダイヤルプッシュ率・SMS到達率を1箇所で確認できます。"
      />

      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{rows.length} アカウント</span>
        <button
          onClick={load}
          className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-sm hover:bg-brand-700"
        >
          更新
        </button>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          読み込み中...
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-4 py-2">アカウント</th>
                <th className="px-4 py-2">URLクリック数</th>
                <th className="px-4 py-2">LINE追加数</th>
                <th className="px-4 py-2">LINE追加率</th>
                <th className="px-4 py-2">アンケート完了率</th>
                <th className="px-4 py-2">ダイヤルプッシュ率</th>
                <th className="px-4 py-2">SMS到達率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.accountId} className="border-t border-gray-100">
                  <td className="px-4 py-2">{r.name}</td>
                  <td className="px-4 py-2">{r.lpClicks}</td>
                  <td className="px-4 py-2">{r.lineFriends}</td>
                  <td className="px-4 py-2">{pct(r.lineAddRate)}</td>
                  <td className="px-4 py-2">
                    {r.surveyCompletionRate}%（{r.surveyDone}/{r.surveyTotal}）
                  </td>
                  <td className="px-4 py-2">{pct(r.dialPushRate)}</td>
                  <td className="px-4 py-2">{pct(r.smsDeliveredRate)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    データがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
