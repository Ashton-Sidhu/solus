import { mount, unmount } from 'svelte'
import FrontMatterNodeView from './FrontMatterNodeView.svelte'
import { FrontMatterMarkdownExtension, setFrontMatterValue } from './lib/front-matter'

/** Front matter shown as a list of properties. See `lib/front-matter.ts`. */
export const FrontMatterExtension = FrontMatterMarkdownExtension.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'doc-front-matter'
      const current = { yaml: String(node.attrs.yaml ?? '') }
      const component = mount(FrontMatterNodeView, {
        target: dom,
        props: {
          yaml: current.yaml,
          isEditable: () => editor.isEditable,
          onCommit: (key: string, value: string) => {
            const pos = getPos()
            if (pos == null || !editor.isEditable) return
            const yaml = setFrontMatterValue(current.yaml, key, value)
            if (yaml === current.yaml) return
            current.yaml = yaml
            component.setYaml(yaml)
            editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeAttribute(pos, 'yaml', yaml)
                return true
              })
              .run()
          },
          onDone: () => editor.commands.focus(),
        },
      })
      return {
        dom,
        update(nextNode) {
          if (nextNode.type.name !== 'frontMatter') return false
          const yaml = String(nextNode.attrs.yaml ?? '')
          if (yaml !== current.yaml) {
            current.yaml = yaml
            component.setYaml(yaml)
          }
          return true
        },
        // The fields own their pointer and key events; ProseMirror claiming
        // them would turn a click into a node selection and typing into edits.
        stopEvent: (event) => event.target instanceof Element && !!event.target.closest('textarea'),
        ignoreMutation: () => true,
        destroy() {
          void unmount(component)
        },
      }
    }
  },
})
