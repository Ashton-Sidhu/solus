import { memo, useMemo } from 'react'
import { Linking, ScrollView, Text, View } from 'react-native'
import { usePalette } from '../../../theme/theme'
import { CODE_FONT, radius, space, type } from '../../../theme/tokens'
import { isOpenableUrl, parseMarkdown, type Inline } from '../lib/markdown'

/** Selectable agent prose. Parsed once per text value. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const palette = usePalette()
  const blocks = useMemo(() => parseMarkdown(text), [text])

  const inlines = (spans: Inline[]) => spans.map((span, index) => {
    switch (span.kind) {
      case 'code':
        return <Text key={index} style={{ fontFamily: CODE_FONT, fontSize: type.code, backgroundColor: palette.accentSoft }}>{span.text}</Text>
      case 'strong':
        return <Text key={index} style={{ fontWeight: '700' }}>{span.text}</Text>
      case 'em':
        return <Text key={index} style={{ fontStyle: 'italic' }}>{span.text}</Text>
      case 'link':
        return isOpenableUrl(span.url)
          ? <Text key={index} accessibilityRole="link" style={{ color: palette.accent, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(span.url)}>{span.text}</Text>
          : <Text key={index} style={{ color: palette.accent }}>{span.text}</Text>
      default:
        return span.text
    }
  })

  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'code':
            return (
              <ScrollView key={index} horizontal style={{ backgroundColor: palette.surface, borderRadius: radius.sm, borderWidth: 1, borderColor: palette.border }} contentContainerStyle={{ padding: space.sm }}>
                <Text selectable style={{ fontFamily: CODE_FONT, fontSize: type.code, color: palette.text }}>{block.text}</Text>
              </ScrollView>
            )
          case 'heading':
            return <Text key={index} selectable accessibilityRole="header" style={{ color: palette.text, fontSize: block.level <= 2 ? type.title : type.body, fontWeight: '700' }}>{inlines(block.inlines)}</Text>
          case 'list':
            return (
              <View key={index} style={{ gap: 2 }}>
                {block.items.map((item, itemIndex) => (
                  <Text key={itemIndex} selectable style={{ color: palette.text, fontSize: type.body, lineHeight: 22 }}>
                    {block.ordered ? `${itemIndex + 1}. ` : '•  '}{inlines(item)}
                  </Text>
                ))}
              </View>
            )
          case 'quote':
            return <Text key={index} selectable style={{ color: palette.textSecondary, fontSize: type.body, borderLeftWidth: 3, borderLeftColor: palette.border, paddingLeft: space.sm }}>{inlines(block.inlines)}</Text>
          default:
            return <Text key={index} selectable style={{ color: palette.text, fontSize: type.body, lineHeight: 22 }}>{inlines(block.inlines)}</Text>
        }
      })}
    </View>
  )
})
