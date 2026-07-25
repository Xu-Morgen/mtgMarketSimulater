import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { PackSlotDto } from "@mtg-market/contracts";

type ProbabilityRow = { id: string; rarity: string; probabilityBasisPoints: number };

function formatProbability(probabilityBasisPoints: number): string {
  return `${(probabilityBasisPoints / 100).toFixed(2)}%（${probabilityBasisPoints.toLocaleString("zh-CN")} bp）`;
}

const columns: ColumnsType<ProbabilityRow> = [
  { title: "稀有度", dataIndex: "rarity", key: "rarity" },
  {
    title: "服务端公示概率",
    dataIndex: "probabilityBasisPoints",
    key: "probabilityBasisPoints",
    render: formatProbability
  }
];

/** 仅格式化 API 的 basis points；不在客户端合成概率或运行任何抽取规则。 */
export function PackProbabilityTable({ slots }: { slots: PackSlotDto[] }) {
  return (
    <section aria-label="卡位与稀有度概率">
      <h2>卡位与稀有度概率</h2>
      {slots.map((slot) => (
        <section className="pack-slot" key={slot.id}>
          <h3>{slot.id} 卡位</h3>
          <p>每包抽取次数：{slot.draws}</p>
          <Table<ProbabilityRow>
            columns={columns}
            dataSource={slot.rarityProbabilities.map((probability) => ({
              id: `${slot.id}-${probability.rarity}`,
              ...probability
            }))}
            rowKey="id"
            pagination={false}
            size="small"
            scroll={{ x: 480 }}
          />
        </section>
      ))}
    </section>
  );
}
