import Foundation
import Security

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: set-local-mac-keychain-secret <service> <account>\n".utf8))
    exit(64)
}

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let secretData = FileHandle.standardInput.readDataToEndOfFile()

guard !secretData.isEmpty else {
    FileHandle.standardError.write(Data("secret data is required on stdin\n".utf8))
    exit(65)
}

var trustedApplication: SecTrustedApplication?
guard SecTrustedApplicationCreateFromPath("/usr/bin/security", &trustedApplication) == errSecSuccess,
      let trustedApplication else {
    FileHandle.standardError.write(Data("could not configure Keychain reader access\n".utf8))
    exit(70)
}

var access: SecAccess?
let accessStatus = SecAccessCreate(
    "VariaMos local SSH test" as CFString,
    [trustedApplication] as CFArray,
    &access
)
guard accessStatus == errSecSuccess, let access else {
    FileHandle.standardError.write(Data("could not configure Keychain item access\n".utf8))
    exit(70)
}

let identity: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

SecItemDelete(identity as CFDictionary)

var item = identity
item[kSecAttrLabel as String] = "VariaMos local SSH test"
item[kSecAttrAccess as String] = access
item[kSecValueData as String] = secretData

let status = SecItemAdd(item as CFDictionary, nil)
guard status == errSecSuccess else {
    FileHandle.standardError.write(Data("could not store the Keychain item (status \(status))\n".utf8))
    exit(74)
}
