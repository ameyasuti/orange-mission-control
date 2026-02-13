from pathlib import Path
import re
p = Path('orange-mission-control/app/login/page.tsx')
s = p.read_text(encoding='utf-8')
# remove the allowlist block
s2 = re.sub(
    r"\n\s*const allowed = process\.env\.NEXT_PUBLIC_ALLOWED_EMAIL\?\.trim\(\)\.toLowerCase\(\);\n\s*if \(allowed && email\.trim\(\)\.toLowerCase\(\) !== allowed\) \{\n\s*throw new Error\('Access is restricted for this pilot\.'\);\n\s*\}\n",
    "\n",
    s,
)
if s2 == s:
    print('pattern not found; no changes')
else:
    p.write_text(s2, encoding='utf-8')
    print('updated', p)
