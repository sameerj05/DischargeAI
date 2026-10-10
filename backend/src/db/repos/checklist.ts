import type { Db } from "../index.js";

export interface ChecklistStateRow {
  link_id_hash: string;
  item_id: string;
  completed: number;
  updated_at: string;
}

export interface ChecklistItemState {
  itemId: string;
  completed: boolean;
  updatedAt: string;
}

export class ChecklistRepo {
  constructor(private readonly db: Db) {}

  async upsert(linkIdHash: string, itemId: string, completed: boolean, now: string): Promise<void> {
    await this.db.upsert("checklist_state", ["link_id_hash", "item_id"], { link_id_hash: linkIdHash, item_id: itemId, completed: completed ? 1 : 0, updated_at: now });
  }

  async listForLink(linkIdHash: string): Promise<ChecklistItemState[]> {
    const rows = await this.db.all<ChecklistStateRow>(
      "SELECT * FROM checklist_state WHERE link_id_hash = ? ORDER BY item_id",
      [linkIdHash],
    );
    return rows.map((r) => ({ itemId: r.item_id, completed: Number(r.completed) === 1, updatedAt: r.updated_at }));
  }

  async deleteForLink(linkIdHash: string): Promise<void> {
    await this.db.run("DELETE FROM checklist_state WHERE link_id_hash = ?", [linkIdHash]);
  }
}
