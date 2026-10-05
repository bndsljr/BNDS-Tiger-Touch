/**
 * 已知「URL 存在但参数构造不出来」的方法 → 替代方法映射。
 *
 * ## 背景（见调研笔记 §2.1.1）
 *
 * 语料中 **466 页**的 script URL 带裸对象占位 `={}` —— 表示文档生成器
 * **对该参数类型没有查询串编码方式**（覆盖 `IMenu`、`MenuItem`、`AcwRecordMask`、
 * `Size`、`Timecode`、`KeyValuePair<String,Object>` 等）。
 * 其中只有 39 页同时给出可用长写形式，**余下 427 页按文档无法调用**。
 *
 * **通用解法：找该方法的「有类型兄弟」。** 本表把这些替换固化下来，
 * 使开发期就能得到明确提示，而不是运行时收到一个含糊的 `{}` 编码错误。
 */

export interface Substitution {
  /** 文档中写成对象参数、实际无法构造的方法。 */
  blocked: string;
  /** 应当改用的方法。 */
  use: string;
  /** 为什么 / 怎么用。 */
  note: string;
}

export const METHOD_SUBSTITUTIONS: readonly Substitution[] = [
  {
    blocked: 'Palette.CreatePresetPalettes',
    use: 'Palette.QuickCreatePalette',
    note:
      'CreatePresetPalettes?fixtures={}&option={} 的 fixtures 与 option 都无编码方式。' +
      '改用 QuickCreatePalette，每个调色板一次调用。',
  },
  {
    blocked: 'Group.CreateAutoGroup',
    use: 'Group.QuickCreateGroup',
    note:
      'CreateAutoGroup?handles={} 的 handles 是 IEnumerable<Handle>，' +
      '但该页未给出 handleList 长写形式。改用 ' +
      'QuickCreateGroup(handle, userNumber, legend, iconId)。',
  },
  {
    blocked: 'Group.SetGroupFixtureOrder',
    use: 'Group.SetFixtureOrder',
    note:
      'SetGroupFixtureOrder?orders={} 无编码方式。' +
      '改用 SetFixtureOrder(groupId, fixtureId, x, y, angle) —— 每个灯具一次调用。',
  },
  {
    blocked: 'Programmer.Editor.Fixtures.SetControlValue',
    use: 'Programmer.Editor.Fixtures.SetControlValueById 或 SetControlValueByName',
    note: 'control={} 是 IFixtureAttribute 对象。改用 ById(controlId) 或 ByName(controlName)。',
  },
  {
    blocked: 'Editor.Shapes.BlockShape',
    use: 'Playbacks.SetCueBlockedShape',
    note: 'menuItem={} 无法构造。改用 SetCueBlockedShape(playbackId, cueId, shapeId, blocked)。',
  },
  {
    blocked: 'Editor.Shapes.ToggleShapeAbsolute',
    use: 'Editor.Shapes.CreateShape（absolute=true）',
    note: 'listItem={} 无法构造。或在 CreateShape 时直接指定 absolute，' +
      '或写 Editor/Shapes/PropertiesInProgrammer 属性。',
  },
  {
    blocked: 'Shapes.AddFixturesToShape',
    use: 'Editor.Shapes.AddShapeFixtures',
    note: 'shapeInformation={} 无法构造。改用 AddShapeFixtures(shapeId, fixtureIds)。',
  },
  {
    blocked: 'Editor.Shapes.SetSelectedViewShape',
    use: 'Editor.Shapes.SetSelectedViewShapes',
    note: 'shapeInformation={} 无法构造。复数版有 handle 长写形式。',
  },
  {
    blocked: 'Menu.GetItemTag',
    use: '—',
    note: 'MenuItem 类型的编码方式从未展示。菜单类方法整体不纳入本项目设计。',
  },
];

const BLOCKED_INDEX = new Map(METHOD_SUBSTITUTIONS.map((s) => [s.blocked.toLowerCase(), s]));

/** 查询某方法是否有已知替代。`provider.method` 或 `method` 均可。 */
export function findSubstitution(provider: string, method: string): Substitution | undefined {
  return (
    BLOCKED_INDEX.get(`${provider}.${method}`.toLowerCase()) ?? BLOCKED_INDEX.get(method.toLowerCase())
  );
}

/**
 * 已知「属性参数从未出现过字面量示例」的类型 —— 编码正确性置信度不足。
 *
 * 最典型的是 `AcwUserNumber`：`{userNumber}` 在全语料出现 43 次
 * **全部保留占位符**，零字面量示例。而它落在关键路径上
 * （`Group.StoreGroup`、`Group.QuickCreateGroup`、`Palette.QuickCreatePalette`、
 *  `Handles.GetHandleFromUserNumber` 等约 15 个方法）。
 * 唯一证据来自**过时的 Introduction**（`?userNumber=20`）。
 *
 * → 按普通整数处理，但**置信度中等，须尽早实测**。
 */
export const MEDIUM_CONFIDENCE_TYPES: readonly { type: string; reason: string }[] = [
  {
    type: 'AcwUserNumber',
    reason: '全语料 43 处占位符、零字面量示例；唯一证据来自过时 Introduction 的 ?userNumber=20',
  },
  {
    type: 'ExportType',
    reason: 'Reports.GenerateReport 的 format 参数类型，全语料中不存在该枚举页',
  },
  {
    type: 'SetRecordType 取值',
    reason: '录制类型枚举取值未文档化',
  },
  {
    type: 'masterType 取值',
    reason: '主控类型枚举取值未文档化',
  },
  {
    type: 'LockStates / HandleOperations / MenuEventTypes',
    reason: '枚举取值未文档化',
  },
];
