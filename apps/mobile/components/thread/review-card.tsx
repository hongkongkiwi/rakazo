import type { MessageBlock } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";

type ReviewBlock = Extract<MessageBlock, { kind: "review" }>;

export function ReviewCard({ block }: { block: ReviewBlock }) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const verdict =
    block.verdict === "pass"
      ? t("Pass")
      : block.verdict === "concerns"
        ? t("Concerns")
        : t("Unclear");
  const tone =
    block.verdict === "pass"
      ? tokens.success
      : block.verdict === "concerns"
        ? tokens.warning
        : tokens.mutedForeground;
  return (
    <View
      testID="review-card"
      style={{
        width: "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
          {t("Advisory review")}
        </Text>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>·</Text>
        <Text style={{ color: tone, ...typeScale.caption }}>{verdict}</Text>
      </View>
      <Text style={{ color: tokens.foreground, ...typeScale.secondary }}>{block.summary}</Text>
      {block.findings.map((finding, index) => (
        <Text
          key={`${index}-${finding}`}
          style={{ color: tokens.mutedForeground, ...typeScale.secondary }}
        >
          • {finding}
        </Text>
      ))}
    </View>
  );
}
