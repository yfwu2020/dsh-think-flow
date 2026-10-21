// ── 命令行的两种活：查 vs 跑 ──
//
// 分界不是"哪个命令"，而是**这条命令在干嘛**：
//   · 查 = 只读、没有副作用（sed/grep/cat/ls/wc…）
//   · 跑 = 会做事（跑测试/构建/脚本/提交/联网，以及改文件系统的 cp/mkdir/rm）
// 为什么值得分：实测一个真实会话的 89 条命令，70% 是"把这段读出来看看"，
// 28% 是"跑测试/构建/提交"。混在一起叫什么都别扭 —— 叫"排查"过窄
// （它专指查故障，而多数只是读代码），也漏掉那 28%。
// 但**分组不能跟着拆**：分组用的是定标过的 90s 阈值，夹在两次 grep 之间的
// 一个 `npm test` 会单独成块，把列表切碎（20s 阈值那次就被切碎成 9 块）。
// 所以：分组仍按"命令行"一族，**显示名按块内实际内容算**。
var CMD_INSPECT = {
  sed: 1, grep: 1, rg: 1, cat: 1, head: 1, tail: 1, wc: 1, find: 1, ls: 1,
  stat: 1, du: 1, tree: 1, lsof: 1, ps: 1, pgrep: 1, file: 1, which: 1,
  env: 1, awk: 1, cut: 1, sort: 1, uniq: 1, diff: 1, echo: 1, basename: 1, dirname: 1,
}

var CMD_RUN = {
  npm: 1, npx: 1, pnpm: 1, yarn: 1, node: 1, python: 1, python3: 1, bash: 1, sh: 1,
  make: 1, git: 1, curl: 1, gh: 1, zstd: 1, sips: 1, open: 1,
  // 改文件系统也算"做事"（有副作用），不算"查看"
  mkdir: 1, cp: 1, mv: 1, rm: 1, ln: 1, touch: 1, chmod: 1,
}

/**
 * 一条 bash 命令在干嘛。
 *
 * 只看**第一个动词**：`cd X && sed -n …` 要先剥掉 `cd X &&`，
 * 因为所有命令都以前缀的 cd 开头（实测 89 条里几乎全部如此）。
 *
 * ⚠️ 这里必须能处理**被截断的参数**：宿主只留 `arguments` 的前 400 字，
 * 而长命令（heredoc、多行脚本）一截就**不是合法 JSON 了** —— 实测一个真实会话里
 * 207 次 bash 调用有 **118 次**（57%）解析失败。解析不了就返回 null 的话，
 * 大半个命令行块都会退化成中性的"命令行"，这个功能就等于没做。
 * 好在我们只要命令的**第一个词**，它必定在最前面，所以再从原始串里捞一次就够了。
 * @param argsRaw - 工具参数原文（JSON 字符串，可能被截断）。
 * @returns `'inspect'` / `'run'` / `null`（认不出来）。
 */
/**
 * 从工具参数里取出命令原文。
 *
 * ⚠️ 必须容忍**被截断的参数**：宿主只留 `arguments` 的前 400 字，长命令
 * （heredoc、多行脚本）一截就不是合法 JSON 了 —— 实测一个真实会话里
 * 337 次 bash 调用有相当一部分如此。解析不了就从原始串里捞 command 的开头，
 * 反正标题只需要命令的**开头几个词**。
 * @param argsRaw - 工具参数原文（JSON 字符串，可能被截断）。
 * @returns 命令原文；取不到时空串。
 */
function commandOf(argsRaw) {
  if (typeof argsRaw !== 'string' || argsRaw === '') return ''
  try {
    var parsed = JSON.parse(argsRaw)
    return parsed && typeof parsed.command === 'string' ? parsed.command : ''
  } catch (e) {
    var m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argsRaw)
    if (m === null) return ''
    return m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
}

/**
 * 把整条命令切成"段"（`&&` / `;` / `|` / `||`），**但要跳过引号里的**。
 *
 * 踩过：`sed -n "$(grep -n 'x' f | cut -d: -f1),+8p" f` 这种命令里，
 * 引号内的 `|` 是命令替换的一部分，按裸 `|` 切会把一段劈成两半，
 * 于是"最后一个参数"变成半截字符串（起出过 `读 index.js ` 这种带尾巴的标题）。
 */
function splitSegments(cmd) {
  var out = []
  var cur = ''
  var quote = ''
  for (var i = 0;i < cmd.length;i += 1) {
    var ch = cmd[i]
    if (quote !== '') {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '&' && cmd[i + 1] === '&') { out.push(cur); cur = ''; i += 1; continue }
    if (ch === '|') {
      if (cmd[i + 1] === '|') i += 1
      out.push(cur); cur = ''
      continue
    }
    if (ch === ';') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

/** 把一段命令切成 token（粗略处理单双引号）。 */
function shellTokens(text) {
  var out = []
  var cur = ''
  var quote = ''
  for (var i = 0;i < text.length;i += 1) {
    var ch = text[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (cur !== '') { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

/** 去掉开头的 cd / VAR=值 / sudo 这类"导航前缀"。 */
function stripNav(text) {
  var t = text.replace(/^\s+/, '')
  for (var i = 0;i < 6;i += 1) {
    var before = t
    t = t.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
    t = t.replace(/^(?:sudo|command|time)\s+/, '')
    t = t.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:&&|;)?\s*/, '')
    t = t.replace(/^(?:&&|;|\|\|)\s*/, '')
    if (t === before) break
  }
  return t
}

/** 取最后一个看起来像路径的 token 的文件名部分。 */
function baseName(tok) {
  if (tok === undefined) return ''
  var t = String(tok).replace(/\/+$/, '')
  var i = t.lastIndexOf('/')
  return i >= 0 ? t.slice(i + 1) : t
}

/**
 * 从参数里挑出"那个文件"。
 *
 * ⚠️ 不能简单取"第二个实参"：命令替换里**嵌了同类引号**时，分词器会被里面的引号
 * 带偏，把一整段 shell 片段当成一个 token —— 真机起出过
 * 「读 test-client.mjs | cut -d: -f1),+26p」这种标题（`sed -n "$(grep -n "x" f | cut -d: -f1),+26p" f`）。
 * 改成**从后往前找第一个"看起来像路径"的 token**：只含 `[\w.~/@-]`，
 * 不含空格 / 引号 / `|` / `,` 这些 shell 元字符，也不是 sed 的 `s/a/b/` 脚本。
 * @param toks - 该段的 token。
 * @returns 文件 token；挑不出时 undefined。
 */
function pickPath(toks) {
  // 从 `length-1` 扫到 **1**：第 0 个是动词本身（`sed`/`cat`/`ls` 都长得像路径），
  // 扫到它就会起出「改 sed」这种标题（`sed -i '' 's/x/y/'` 没有文件名时踩到过）
  for (var i = toks.length - 1;i >= 1;i -= 1) {
    var t = toks[i]
    if (t.charAt(0) === '-') continue
    if (!/^[A-Za-z0-9_.~\/@-]+$/.test(t)) continue
    if (/^[sy]\//.test(t)) continue          // sed 的 s/a/b/ 脚本，不是文件
    return t
  }
  return undefined
}

/** 非 - 开头的 token（也就是参数里的"实参"）。 */
function nonFlags(toks) {
  var out = []
  for (var i = 0;i < toks.length;i += 1) {
    if (toks[i].charAt(0) !== '-') out.push(toks[i])
  }
  return out
}

/**
 * 命令里每一段的"信息量"权重 —— 复合命令取最重的那段来起标题。
 *
 * 为什么需要：真实命令大量是 `cd X && …`，也常见 `rm -f a && 跑Chrome截图`。
 * 只取第一段会把后者说成"删文件"。按权重挑，才挑得到真正在干的那件事。
 */
var CMD_WEIGHT = {
  python3: 5, python: 5, node: 5, npm: 5, npx: 5, pnpm: 5, yarn: 5, git: 5, curl: 5, gh: 5,
  sed: 4, grep: 4, rg: 4, awk: 4, cat: 4, find: 4, openpencil: 4,
  ls: 3, tree: 3, wc: 3, du: 3, stat: 3, file: 3, head: 3, tail: 3, diff: 3, sort: 3, uniq: 3,
  zstd: 3, sips: 3, lsof: 3, ps: 3, pgrep: 3, kill: 3, env: 3, printenv: 3, which: 3,
  mkdir: 2, cp: 2, mv: 2, rm: 2, ln: 2, touch: 2, chmod: 2, tar: 2,
  echo: 1, printf: 1, cd: 0, true: 0, export: 0, set: 0,
}

/** 一个动词的权重；不认识的给 3（别被 echo/cp 抢走）。 */
function weightOf(verb) {
  return CMD_WEIGHT[verb] === undefined ? 3 : CMD_WEIGHT[verb]
}

/**
 * 把一条命令压成短标题（**纯本地规则**，不花模型调用）。
 *
 * 为什么这里可以用本地规则：命令是**确定的** —— 动词、参数、文件名都在那儿，
 * 没有"这句话在论证什么"那种需要理解的东西。这和当初否掉"用本地规则总结思考"
 * 是两回事（那个 1/3 会猜错，因为它在猜意图；这个只是在**读**命令）。
 *
 * 认不出来就返回 undefined（界面回落到原来的工具名），**不猜**。
 * @param argsRaw - 工具参数原文。
 * @returns 短标题；认不出时空。
 */
function cmdTitle(argsRaw) {
  var cmd = commandOf(argsRaw)
  if (cmd === '') return ''
  // 复合命令：切成段，挑信息量最大的那段
  var segs = splitSegments(cmd)
  var cands = []
  for (var i = 0;i < segs.length;i += 1) {
    var seg = stripNav(segs[i])
    var toks = shellTokens(seg)
    if (toks.length === 0) continue
    // 子 shell 的 `(` 不算动词的一部分：`(npx … ) || node_modules/.bin/dsh …`
    var w = weightOf(toks[0].replace(/^\(+/, ''))
    if (w > 0) cands.push({ seg: seg, w: w })
  }
  // **按权重降序逐个试，取第一个起得出标题的** —— 只看最重那段的话，
  // 万一那段认不出（比如以 `(` 开头的子 shell），整条就没标题了
  cands.sort(function (a, b) { return b.w - a.w })
  for (var k = 0;k < cands.length;k += 1) {
    var t = titleOfCommand(cands[k].seg)
    if (t !== '') return t
  }
  return ''
}

/** 单个命令段 → 标题。认不出来返回空串。 */
function titleOfCommand(seg) {
  var toks = shellTokens(seg)
  if (toks.length === 0) return ''
  var verb = toks[0].replace(/^\(+/, '')      // 子 shell：`(npx …)`
  var args = nonFlags(toks.slice(1))
  var first = args[0]
  var redirect = /(^|\s)>{1,2}\s*\S/.test(seg)      // `cat > f` / `echo x > f`

  // 读 / 搜 / 看
  if (verb === 'sed') {
    var target = pickPath(toks)
    if (target === undefined) return ''
    if (/-i(\s|$)/.test(seg)) return '改 ' + baseName(target)
    return '读 ' + baseName(target)
  }
  if (verb === 'grep' || verb === 'rg') {
    var pat = (first === undefined ? '' : first).replace(/[\\'"]+$/, '')
    pat = pat.replace(/\\([|\[\](){}.*+?^$])/g, '$1')      // `\|` → `|`，读起来才是人写的
    if (pat.length > 14) pat = pat.slice(0, 13) + '…'
    return pat === '' ? '搜内容' : '搜 ' + pat
  }
  if (verb === 'cat') {
    if (!redirect) return '读 ' + baseName(pickPath(toks))
    // `cat > f` / `cat >> f`：目标在 `>` 之后，别把 `>` 本身当文件名
    var mt = />>?\s*(\S+)/.exec(seg)
    return mt === null ? '写文件' : '写 ' + baseName(mt[1])
  }
  if (verb === 'head' || verb === 'tail') return '读 ' + baseName(pickPath(toks))
  if (verb === 'awk') return '筛 ' + baseName(pickPath(toks))
  if (verb === 'wc') return '数行数'
  if (verb === 'ls') {
    var dir = pickPath(toks)
    return '看目录' + (dir === undefined ? '' : ' ' + baseName(dir))
  }
  if (verb === 'tree') return '看目录树'
  if (verb === 'find') {
    var mn = /-name\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(seg)
    var target = mn === null ? '' : (mn[1] || mn[2] || mn[3] || '')
    return target === '' ? '找文件' : '找 ' + baseName(target).replace(/[*?]/g, '')
  }
  if (verb === 'du' || verb === 'stat' || verb === 'file') {
    var p2 = pickPath(toks)
    return p2 === undefined ? '' : '看 ' + baseName(p2)
  }
  if (verb === 'diff') return '比差异'
  if (verb === 'sort' || verb === 'uniq') return '排序'
  if (verb === 'echo' || verb === 'printf') return '打印一行'
  if (verb === 'for' || verb === 'while' || verb === 'until') return '循环处理'

  // 跑
  if (verb === 'npm' || verb === 'pnpm' || verb === 'yarn') {
    if (first === 'test') return '跑测试'
    if (first === 'run') {
      var script = args[1]
      if (script === undefined) return '跑脚本'
      var NPM_SCRIPT = {
        build: '跑构建', test: '跑测试', preview: '跑预览', align: '跑布局检查',
        icons: '生成图标', probe: '跑探针', typecheck: '跑类型检查'
      }
      return NPM_SCRIPT[script] === undefined ? '跑 ' + script : NPM_SCRIPT[script]
    }
    if (first === 'pack') return '试打包'
    if (first === 'publish') return '发布'
    if (first === 'i' || first === 'install' || first === 'ci') return '装依赖'
    if (first === 'add') return args[1] === undefined ? '装依赖' : '装 ' + args[1]
    return first === undefined ? '跑 npm' : '跑 npm ' + first
  }
  if (verb === 'npx') return first === undefined ? '跑 npx' : '跑 ' + baseName(first)
  if (verb === 'node' || verb === 'python' || verb === 'python3') {
    // `python3 - <<'PY'`（heredoc）、`node -e "…"`、`python3 -c "…"` 都是临时脚本。
    // ⚠️ 要看**原始 token**：`-c` / `-` 被 nonFlags 滤掉了，只能在这里认。
    var inline = false
    for (var ti = 1;ti < toks.length;ti += 1) {
      if (toks[ti] === '-c' || toks[ti] === '-e' || toks[ti] === '-') { inline = true; break }
    }
    if (inline || /<<-?\s*['"]?[A-Za-z_]/.test(seg)) return '跑临时脚本'
    if (first === undefined) return '跑临时脚本'
    return '跑 ' + baseName(first)
  }
  if (verb === 'git') {
    var sub = first
    if (sub === 'add' || sub === 'commit') return '提交改动'
    if (sub === 'diff' || sub === 'status' || sub === 'show') return '看改动'
    if (sub === 'log') return '看提交历史'
    if (sub === 'remote') return '看远端'
    if (sub === 'init') return '建仓库'
    if (sub === 'tag') return '打标签'
    if (sub === 'push') return '推送'
    if (sub === 'clone') return '克隆仓库'
    return sub === undefined ? 'git' : 'git ' + sub
  }
  if (verb === 'bash' || verb === 'sh' || verb === 'zsh') {
    return first === undefined ? '跑脚本' : '跑 ' + baseName(first)
  }
  if (verb === 'curl') return '请求接口'
  if (verb === 'gh') return '用 gh'
  if (verb === 'zstd') return '解压'
  if (verb === 'sips') return '转图片'
  if (verb === 'open') return '打开'

  // 动文件系统
  if (verb === 'mkdir') return '建目录' + (first === undefined ? '' : ' ' + baseName(first))
  if (verb === 'cp') return '复制文件'
  if (verb === 'mv') return '移动文件'
  if (verb === 'rm') return '删文件'
  if (verb === 'ln') return '建链接'
  if (verb === 'touch') return '新建文件'
  if (verb === 'chmod') return '改权限'

  // 看系统
  if (verb === 'lsof' || verb === 'ps' || verb === 'pgrep' || verb === 'kill') return '查进程'
  if (verb === 'env' || verb === 'printenv') return '看环境变量'
  if (verb === 'which') return '找可执行文件'

  // 直接跑一个**带路径的可执行文件**（真机里常见：Chrome 无头截图、node_modules/.bin/dsh）
  if (verb.indexOf('/') >= 0) {
    if (/--screenshot|--headless/.test(seg)) return '跑浏览器截图'
    return '跑 ' + baseName(verb)
  }
  return ''
}

function cmdActivity(argsRaw) {
  var cmd = commandOf(argsRaw)
  if (cmd === '') return null
  var text = cmd.replace(/^\s+/, '')
  // 剥掉开头的"无害前缀"，直到剥不动：
  //   `cd X && …`（几乎所有命令都带）、`VAR=值 …`（`CH="/path with space" python3 …`）、
  //   落单的 `&&`（前一步剥完剩下的）
  for (var i = 0;i < 6;i += 1) {
    var before = text
    text = text.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
    text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:&&|;)?\s*/, '')
    text = text.replace(/^(?:&&|;)\s*/, '')
    if (text === before) break
  }
  var m = /^([A-Za-z0-9_./-]+)/.exec(text)
  if (m === null) return null
  var head = m[1]
  if (CMD_INSPECT[head] === 1) return 'inspect'
  if (CMD_RUN[head] === 1) return 'run'
  return null
}

export { CMD_INSPECT, CMD_RUN, commandOf, splitSegments, shellTokens, stripNav, baseName, pickPath, nonFlags, CMD_WEIGHT, weightOf, cmdTitle, titleOfCommand, cmdActivity }
