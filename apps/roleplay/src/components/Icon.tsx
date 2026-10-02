/** Interface symbols from the DeepSeek Harness icon set, independent from authored story content. */
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronUpOutlineRegular,
  IconSlidersTwoOutlineMedium,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconInfoOutlineRegular,
  IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconCordisPluginOutlineMedium,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconSettingsOutlineRegular,
  IconSparkleRegular,
  IconStopFillRegular,
  IconWarningOutlineRegular,
  IconPaperPlaneOutlineMedium,
  IconLightOutlineRegular,
  IconDarkOutlineRegular,
  IconFollowsystemOutlineRegular,
  IconDataOutlineMedium,
  IconSettingsOutlineMedium,
  IconLinkOutlineMedium,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'

const icons = {
  alert: IconWarningOutlineRegular,
  arrow: IconChevronRightOutlineRegular,
  check: IconCheckOutlineRegular,
  chevron: IconChevronRightOutlineRegular,
  chevronDown: IconChevronDownOutlineRegular,
  chevronLeft: IconChevronLeftOutlineRegular,
  chevronUp: IconChevronUpOutlineRegular,
  sliders: IconSlidersTwoOutlineMedium,
  close: IconCloseOutlineRegular,
  external: IconRightUpOutlineRegular,
  info: IconInfoOutlineRegular,
  menu: IconPanelLeftOutlineRegular,
  newStory: IconNewChatOutlineRegular,
  plus: IconPlusOutlineRegular,
  search: IconSearchOutlineRegular,
  plugin: IconCordisPluginOutlineMedium,
  refresh: IconRefreshOutlineRegular,
  send: IconPaperPlaneOutlineMedium,
  settings: IconSettingsOutlineRegular,
  sparkle: IconSparkleRegular,
  stop: IconStopFillRegular,
  light: IconLightOutlineRegular,
  dark: IconDarkOutlineRegular,
  system: IconFollowsystemOutlineRegular,
  model: IconDataOutlineMedium,
  general: IconSettingsOutlineMedium,
  registry: IconLinkOutlineMedium,
  trash: IconTrashOutlineRegular,
} as const

/** Identifier of one interface symbol. */
export type IconName = keyof typeof icons

/**
 * Render a decorative icon; its surrounding action supplies the accessible name.
 * @param props - Icon identifier and optional pixel size.
 * @returns A decorative SVG without a second accessible name.
 */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Glyph = icons[name]
  return <Glyph size={size} />
}
