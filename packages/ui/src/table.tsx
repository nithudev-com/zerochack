import type { ReactNode } from 'react';

export interface Column<Row> { key: string; header: string; render: (row: Row) => ReactNode; }
export function Table<Row>({ caption, columns, rows, rowKey }: { caption: string; columns: Column<Row>[]; rows: Row[]; rowKey: (row: Row, index: number) => string }) {
  return <div className="ui-table-wrap"><table className="ui-table"><caption className="sr-only">{caption}</caption><thead><tr>{columns.map((column) => <th key={column.key} scope="col">{column.header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={rowKey(row, index)}>{columns.map((column) => <td key={column.key}>{column.render(row)}</td>)}</tr>)}</tbody></table></div>;
}
