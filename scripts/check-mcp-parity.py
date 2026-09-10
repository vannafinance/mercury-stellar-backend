"""Cross-repo parity check: catalog.ts <-> LEGACY_TOOL_MAP <-> the MCP server.

Run from the app repo root:  python scripts/check-mcp-parity.py

IMPORTANT — read the registered name, not the `def` name.
`surface_tools.py` defines some surfaces under one function name and registers them
under another via a `__name__` override, e.g.

    async def vanna_farm_overview_surface(...)   # registered as "vanna_farm_overview"

An earlier version of this script compared against `async def` names and reported drift
that did not exist — then a "fix" based on it broke a working path. The registered name
is the only one the wire ever sees.
"""
import io, os, re, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MCP = os.environ.get('VANNA_MCP_PATH', r'C:\Users\akgam\Documents\vanna_mcp\vanna-mcp')

def read(*parts):
    p = os.path.join(*parts)
    if not os.path.exists(p):
        sys.exit('missing: %s' % p)
    return io.open(p, encoding='utf-8').read()

cat = read(APP, 'lib', 'copilot', 'investigation', 'catalog.ts')
cli = read(APP, 'lib', 'copilot', 'mcp-client.ts')
srf = read(MCP, 'mcp_server', 'tools', 'surface_tools.py')

# Capabilities the model can select: catalogue name -> underlying tool name.
caps = re.findall(r'name:\s*"([a-z_]+)",\s*tool:\s*"([a-z_]+)"', cat)

# App-side remap: legacy flat tool -> (surface, action).
remap = {m[0]: (m[1], m[2]) for m in re.findall(
    r'(vanna_[a-z_]+):\s*\{\s*tool:\s*"([a-z_]+)",\s*action:\s*"([a-z_]+)"', cli)}

# Server surfaces, by REGISTERED name: every vanna_* string literal in surface_tools.py
# plus every `async def vanna_*`. A registered alias appears as a literal; a plainly
# named surface appears as a def. Union covers both without guessing which style is used.
surfaces = set(re.findall(r'^async def (vanna_[a-z_]+)\(', srf, re.M))
surfaces |= set(re.findall(r'"(vanna_[a-z_]+)"', srf))
surfaces |= set(re.findall(r"'(vanna_[a-z_]+)'", srf))

WRITE_ACTIONS = {
    'deposit', 'withdraw', 'borrow', 'repay', 'settle', 'lend', 'open', 'close',
    'deposit_and_borrow', 'swap', 'add_liquidity', 'remove_liquidity', 'redeem',
    'enable', 'disable', 'liquidate',
}

print('capabilities declared to the model : %d' % len(caps))
print('LEGACY_TOOL_MAP entries            : %d' % len(remap))
print('server names (def + registered)    : %d' % len(surfaces))
print()

unresolved, unknown_surface, write_reachable = [], [], []

for cap_name, tool in caps:
    if tool in remap:
        surface, action = remap[tool]
        if surface not in surfaces:
            unknown_surface.append((cap_name, tool, surface))
        if action in WRITE_ACTIONS:
            write_reachable.append((cap_name, tool, surface, action))
    elif tool not in surfaces:
        unresolved.append((cap_name, tool))

def report(title, rows, fmt):
    print('%s  %s' % (title, ('(%d)' % len(rows)) if rows else 'none'))
    for r in rows:
        print('   ' + fmt % r)
    print()

report('[1] capability resolves to nothing on the server', unresolved, '%s -> %s')
report('[2] remap targets a surface the server does not register', unknown_surface, '%s -> %s -> %s')
report('[3] READ capability reachable to a WRITE action', write_reachable, '%s -> %s -> %s/%s')

bad = unresolved or unknown_surface or write_reachable
print('PARITY: ' + ('DRIFT FOUND' if bad else 'OK'))
sys.exit(1 if bad else 0)
