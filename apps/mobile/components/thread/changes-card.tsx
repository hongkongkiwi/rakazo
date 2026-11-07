import type { MessageBlock } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";

type ChangesBlock = Extract<MessageBlock, { kind: "changes" }>;

export function ChangesCard({ block }: { block: ChangesBlock }) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  return (
    <View
      testID="changes-card"
      style={{
        width: "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 6,
      }}
    >
      <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
        {t("Files written")}
      </Text>
      {block.files.map((file) => {
        const status =
          file.change === "created"
            ? t("Created")
            : file.change === "modified"
              ? t("Modified")
              : null;
        return (
          <View key={file.path} style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
            <Text style={{ flexShrink: 1, color: tokens.foreground, ...typeScale.secondary }}>
              {file.path}
            </Text>
            <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
              {status ? `${status} · ` : ""}
              {file.bytes === undefined ? "" : formatFileSize(file.bytes)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
