import { MessageReceipt } from "@talk/shared";
import { StyleSheet, Text, View } from "react-native";

export function ReceiptTicks({ receipt }: { receipt?: MessageReceipt | null }) {
  const status = receipt || "sent";
  const color = status === "read" ? "#1E78F0" : "rgba(17,27,33,0.45)";
  const double = status === "delivered" || status === "read";
  return (
    <View style={styles.wrap} accessibilityLabel={status}>
      <Text style={[styles.mark, { color }]}>✓</Text>
      {double ? <Text style={[styles.mark, styles.second, { color }]}>✓</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginLeft: 4,
    flexDirection: "row",
    alignItems: "center",
    minWidth: 16,
  },
  mark: { fontSize: 13, fontWeight: "800", lineHeight: 16 },
  second: { marginLeft: -5 },
});
