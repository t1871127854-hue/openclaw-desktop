# offline_resources

将 Beta 测试需要的离线资源放到这个目录后，再执行打包命令。

建议至少包含：

- `manifest.json`
- rootfs / runtime 资源
- Node 离线包
- checksum / hash 校验文件

说明：

- `electron-builder` 会把该目录作为 `extraResources` 打进测试包。
- 如果这里只保留本说明文件，则测试包中也只会包含占位目录，不会包含真实离线资源。
