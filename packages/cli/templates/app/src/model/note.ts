/**
 * 领域模型（model 层）：领域类型 + 与存储行的映射意图。
 *
 * 现在保持最小（字段与 `src/schema/note.schema.ts` 的 `fields` 对齐）；
 * 出现复杂映射（Row ↔ 领域对象、值对象、不变量校验）时都放这一层，
 * 别让它渗到控制器或仓储装配里。
 */
export interface Note {
  id?: string;
  version?: number;
  title: string;
}
