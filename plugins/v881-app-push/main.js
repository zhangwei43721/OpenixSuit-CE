export async function deploy({ inputs }, host) {
  const { local_file, remote_dir, remote_name } = inputs;
  if (!local_file || !remote_dir || !remote_name) {
    throw new Error("请填写本地文件、设备目录和设备端文件名");
  }
  host.progress(10);
  host.log(`准备部署 ${local_file} 到 ${remote_dir}/${remote_name}`);
  const result = await host.call("adb.deploy", {
    local_path: local_file,
    remote_dir,
    remote_name,
    need_root: inputs.need_root === true,
    restart_cmd: inputs.restart_cmd || ""
  });
  host.progress(100);
  host.log("应用部署流程已完成");
  return { result };
}
