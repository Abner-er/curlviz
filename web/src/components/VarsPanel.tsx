import type { CurlSpec, Param } from '@curlviz/core'
import { usedVars } from '../lib/display'
import { KeyValueTable } from './KeyValueTable'
import { useMemo } from 'react'

interface Props {
  spec: CurlSpec
  vars: Record<string, string>
  onChange: (vars: Record<string, string>) => void
}

export function VarsPanel({ spec, vars, onChange }: Props) {
  const used = useMemo(() => usedVars(spec), [spec])
  const rows: Param[] = useMemo(() => {
    const keys = [...new Set([...used, ...Object.keys(vars)])].sort()
    return keys.map((k) => ({ key: k, value: vars[k] ?? '', enabled: true }))
  }, [used, vars])

  const missing = used.filter((k) => (vars[k] ?? '') === '')

  return (
    <div>
      <p className="muted">
        命令里写 <code className="mono">{'{{名字}}'}</code>，这里填值。发送前会替换；没填的会按字面量发出去并明确提示。
      </p>
      {missing.length > 0 && (
        <ul className="notes">
          <li className="err">还没赋值：{missing.join('、')}</li>
        </ul>
      )}
      <KeyValueTable
        rows={rows}
        onChange={(next) => {
          const out: Record<string, string> = {}
          for (const r of next) if (r.key.trim() !== '') out[r.key.trim()] = r.value
          onChange(out)
        }}
        keyPlaceholder="变量名"
        valuePlaceholder="值"
        pairLabel="变量 / 值"
      />
    </div>
  )
}
