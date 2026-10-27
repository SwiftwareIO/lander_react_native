import Foundation

/// Swift side of the RNLander module: platform info and the SDK's small key
/// value storage, kept in Application Support and excluded from backups so it
/// is never restored onto another device.
@objc(RNLanderImpl)
public final class RNLanderImpl: NSObject {
  private let io = DispatchQueue(label: "link.lander.reactnative.storage")
  private static let keyPattern = try! NSRegularExpression(pattern: "^[a-z0-9_]{1,64}$")

  @objc public static func appVersion() -> String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
  }

  /// The OS version as UIDevice reports it, for example `18.1` or `18.1.1`.
  @objc public static func osVersion() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return v.patchVersion > 0
      ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
      : "\(v.majorVersion).\(v.minorVersion)"
  }

  @objc public func read(
    _ key: String, resolve: @escaping (Any?) -> Void,
    reject: @escaping (String?, String?, Error?) -> Void
  ) {
    storage(key, resolve, reject) { file in
      guard let data = try? Data(contentsOf: file) else { return nil }
      return String(data: data, encoding: .utf8)
    }
  }

  @objc public func write(
    _ key: String, value: String, resolve: @escaping (Any?) -> Void,
    reject: @escaping (String?, String?, Error?) -> Void
  ) {
    storage(key, resolve, reject) { file in
      try Data(value.utf8).write(to: file, options: .atomic)
      return nil
    }
  }

  @objc public func remove(
    _ key: String, resolve: @escaping (Any?) -> Void,
    reject: @escaping (String?, String?, Error?) -> Void
  ) {
    storage(key, resolve, reject) { file in
      if FileManager.default.fileExists(atPath: file.path) {
        try FileManager.default.removeItem(at: file)
      }
      return nil
    }
  }

  private func storage(
    _ key: String, _ resolve: @escaping (Any?) -> Void,
    _ reject: @escaping (String?, String?, Error?) -> Void,
    _ op: @escaping (URL) throws -> String?
  ) {
    guard
      Self.keyPattern.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)) != nil
    else {
      reject("invalid_key", "Invalid storage key", nil)
      return
    }
    io.async {
      do {
        let file = try Self.storageDirectory().appendingPathComponent(key)
        resolve(try op(file))
      } catch {
        reject("storage_error", error.localizedDescription, error)
      }
    }
  }

  private static func storageDirectory() throws -> URL {
    var dir = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("lander_react_native", isDirectory: true)
    if !FileManager.default.fileExists(atPath: dir.path) {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    // Checked on every access, not only on creation: the flag can be lost when
    // the directory is restored or migrated, and the install ID must never
    // move to another device.
    if (try? dir.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup != true {
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try dir.setResourceValues(values)
    }
    return dir
  }
}
