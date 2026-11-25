export async function upgrade({ inputs }, host) {
  const partition = inputs.target_partition;
  const image = inputs.slot_image;
  if (!image || !partition) throw new Error("请选择镜像文件和目标分区");

  host.progress(5);
  host.log(`检查 V881 ${partition} 分区的当前槽位`);
  const inspected = await host.call("adb.partition.inspect", { partition });
  const normalizeSlot = value => String(value || "").replace(/^_/, "").toLowerCase();
  if (!inspected || !["a", "b"].includes(normalizeSlot(inspected.current_slot))) {
    throw new Error("设备未返回有效的当前 A/B 槽位，已停止升级");
  }
  if (!["a", "b"].includes(normalizeSlot(inspected.target_slot)) ||
      normalizeSlot(inspected.current_slot) === normalizeSlot(inspected.target_slot)) {
    throw new Error("宿主返回的目标槽位无效，已停止升级");
  }

  host.log(`当前槽位 ${inspected.current_slot}，准备写入 ${inspected.target_slot}`);
  host.progress(20);
  const result = await host.call("adb.partition.write", {
    partition,
    local_path: image,
    expected_slot: inspected.target_slot,
    reboot: inputs.auto_reboot === true
  });
  host.progress(100);
  host.log(result?.rebooted ? "镜像读回校验完成，设备已重启" : "镜像读回校验完成，设备保持运行");
  return { result };
}
