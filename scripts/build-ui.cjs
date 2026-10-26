const fs = require('node:fs')
const path = require('node:path')
const {compile} = require('@tailwindcss/node')
async function build() {
  const root = path.resolve(__dirname, '..')
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  const candidates = [...new Set([...html.matchAll(/class=["']([^"']+)["']/g)].flatMap(m => m[1].split(/\s+/)))]
  const compiler = await compile(fs.readFileSync(path.join(root, 'assets/css/utilities.css'), 'utf8'), {base: root, onDependency() {}})
  fs.writeFileSync(path.join(root, 'public/ui/utilities.css'), compiler.build(candidates))
  fs.copyFileSync(path.join(root, 'assets/css/components.css'), path.join(root, 'public/ui/components.css'))
}
build().catch(error => {console.error(error); process.exitCode = 1})
