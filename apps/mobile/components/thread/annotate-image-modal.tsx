import type { ImageAnnotationMark } from "@rakazo/contracts";
import { IMAGE_ANNOTATION_MAX_MARKS } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Rect, Text as SvgText } from "react-native-svg";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { PickedAttachment } from "../../lib/pick-attachments";
import { errorText } from "../../lib/user-error";

type Point = { x: number; y: number };
type Draft = Point & { width: number; height: number };

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function AnnotateImageModal({
  attachment,
  target,
  onClose,
  onSaved,
}: {
  attachment: PickedAttachment;
  target: { botId: string } | { groupId: string };
  onClose: () => void;
  onSaved: (saved: { artifactId: string; mimeType: string }) => void;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const window = useWindowDimensions();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [marks, setMarks] = useState<ImageAnnotationMark[]>([]);
  const [revision, setRevision] = useState(0);
  // A reopened editor must not reuse the previous save's idempotency key.
  const [sessionId] = useState(() => newClientId());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const start = useRef<Point | null>(null);
  const draftRef = useRef<Draft | null>(null);

  // A picked image normally has a preview file; a shared one may only carry bytes.
  const previewUri =
    attachment.previewUri ?? `data:${attachment.mimeType};base64,${attachment.contentBase64}`;
  useEffect(() => {
    Image.getSize(
      previewUri,
      (width, height) => setSize({ width, height }),
      () => setError(t("This image could not be read")),
    );
  }, [previewUri, t]);

  const display = useMemo(() => {
    if (!size) return null;
    const scale = Math.min(
      (window.width - 32) / size.width,
      (window.height * 0.5) / size.height,
      1,
    );
    return { width: size.width * scale, height: size.height * scale };
  }, [size, window.height, window.width]);

  const changeMarks = (next: ImageAnnotationMark[]) => {
    setMarks(next);
    setRevision((current) => current + 1);
  };

  const point = (x: number, y: number): Point => {
    if (!display) return { x: 0, y: 0 };
    return { x: clamp(x / display.width), y: clamp(y / display.height) };
  };

  const finish = () => {
    const next = draftRef.current;
    start.current = null;
    draftRef.current = null;
    setDraft(null);
    if (!next || next.width < 0.02 || next.height < 0.02) return;
    changeMarks([...marks, next]);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !saving && marks.length < IMAGE_ANNOTATION_MAX_MARKS,
        onMoveShouldSetPanResponder: () => !saving && marks.length < IMAGE_ANNOTATION_MAX_MARKS,
        onPanResponderGrant: (event) => {
          const from = point(event.nativeEvent.locationX, event.nativeEvent.locationY);
          start.current = from;
          draftRef.current = { ...from, width: 0, height: 0 };
          setDraft(draftRef.current);
        },
        onPanResponderMove: (event) => {
          const from = start.current;
          if (!from) return;
          const to = point(event.nativeEvent.locationX, event.nativeEvent.locationY);
          const next = {
            x: Math.min(from.x, to.x),
            y: Math.min(from.y, to.y),
            width: Math.abs(to.x - from.x),
            height: Math.abs(to.y - from.y),
          };
          draftRef.current = next;
          setDraft(next);
        },
        onPanResponderRelease: finish,
        onPanResponderTerminate: finish,
      }),
    // The handlers read the current marks, displayed size, and save state.
    [marks, display, saving],
  );

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const artifact = await rpc(
        "artifacts/annotate",
        {
          ...target,
          name: attachment.name,
          mimeType: attachment.mimeType,
          contentBase64: attachment.contentBase64,
          marks,
          clientNonce: `annotation:${attachment.id}:${sessionId}:${revision}`,
        },
        { timeoutMs: 120_000 },
      );
      onSaved({ artifactId: artifact.id, mimeType: artifact.mimeType });
    } catch (cause) {
      setError(errorText(cause, t("Could not annotate this image")));
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => {
        if (!saving) onClose();
      }}
    >
      <View style={{ flex: 1, backgroundColor: tokens.background }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 56,
            paddingBottom: 12,
          }}
        >
          <Pressable onPress={onClose} disabled={saving} accessibilityRole="button">
            <Text style={{ color: tokens.mutedForeground, fontSize: 16 }}>{t("Cancel")}</Text>
          </Pressable>
          <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
            {t("Annotate image")}
          </Text>
          <Pressable
            onPress={() => void save()}
            disabled={saving || marks.length === 0}
            accessibilityRole="button"
          >
            <Text
              style={{
                color: saving || marks.length === 0 ? tokens.mutedForeground : tokens.foreground,
                fontSize: 16,
                fontWeight: "600",
              }}
            >
              {saving ? t("Saving…") : t("Save")}
            </Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
            {t("Drag over the image to point at what matters.")}
          </Text>
          {display ? (
            <View
              {...responder.panHandlers}
              style={{
                width: display.width,
                height: display.height,
                alignSelf: "center",
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              <Image
                source={{ uri: previewUri }}
                style={{ width: display.width, height: display.height }}
                resizeMode="stretch"
              />
              <Svg
                style={{ position: "absolute", left: 0, top: 0 }}
                width={display.width}
                height={display.height}
              >
                {marks.map((mark, index) => (
                  <Rect
                    key={`${index}-${mark.x}-${mark.y}`}
                    x={mark.x * display.width}
                    y={mark.y * display.height}
                    width={mark.width * display.width}
                    height={mark.height * display.height}
                    stroke="#e11d48"
                    strokeWidth={3}
                    fill="rgba(225, 29, 72, 0.08)"
                  />
                ))}
                {marks.map((mark, index) => (
                  <Circle
                    key={`badge-${index}`}
                    cx={mark.x * display.width + 14}
                    cy={mark.y * display.height + 14}
                    r={12}
                    fill="#e11d48"
                  />
                ))}
                {marks.map((mark, index) => (
                  <SvgText
                    key={`number-${index}`}
                    x={mark.x * display.width + 14}
                    y={mark.y * display.height + 18}
                    fill="#ffffff"
                    fontSize={14}
                    fontWeight="700"
                    textAnchor="middle"
                  >
                    {index + 1}
                  </SvgText>
                ))}
                {draft ? (
                  <Rect
                    x={draft.x * display.width}
                    y={draft.y * display.height}
                    width={draft.width * display.width}
                    height={draft.height * display.height}
                    stroke="#e11d48"
                    strokeWidth={2}
                    fill="rgba(225, 29, 72, 0.08)"
                  />
                ) : null}
              </Svg>
            </View>
          ) : null}
          {marks.map((mark, index) => (
            <View
              key={`${index}-${mark.x}-${mark.y}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: "#e11d48",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "700" }}>
                  {index + 1}
                </Text>
              </View>
              <TextInput
                value={mark.label ?? ""}
                editable={!saving}
                onChangeText={(text) =>
                  changeMarks(
                    marks.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, label: text || undefined }
                        : candidate,
                    ),
                  )
                }
                placeholder={t("What is wrong here?")}
                placeholderTextColor={tokens.mutedForeground}
                maxLength={200}
                style={{
                  flex: 1,
                  height: 40,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: tokens.border,
                  backgroundColor: tokens.card,
                  color: tokens.foreground,
                  paddingHorizontal: 12,
                }}
              />
              <Pressable
                accessibilityLabel={t("Remove box {index}", { index: index + 1 })}
                disabled={saving}
                hitSlop={8}
                onPress={() => changeMarks(marks.filter((_, i) => i !== index))}
              >
                <Text style={{ color: tokens.mutedForeground, fontSize: 20 }}>×</Text>
              </Pressable>
            </View>
          ))}
          {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
