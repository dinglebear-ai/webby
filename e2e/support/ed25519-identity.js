import {createHash, generateKeyPairSync, sign} from "node:crypto"

function chromeAlphabet(bytes) {
  let result = ""
  for (const byte of bytes) result += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))
  return result
}

export class Ed25519Identity {
  constructor({privateKey, publicKey, extensionId} = {}) {
    if (!privateKey || !publicKey) ({privateKey: this.privateKey, publicKey: this.publicKey} = generateKeyPairSync("ed25519"))
    else { this.privateKey = privateKey; this.publicKey = publicKey }
    const jwk = this.publicKey.export({format: "jwk"})
    this.publicKeyRaw = Buffer.from(jwk.x, "base64url")
    this.publicKeyEncoded = this.publicKeyRaw.toString("base64url")
    this.extensionId = extensionId ?? chromeAlphabet(createHash("sha256").update(this.publicKey.export({format: "der", type: "spki"})).digest()).slice(0, 32)
    if (!/^[a-p]{32}$/.test(this.extensionId)) throw new Error("invalid extension ID")
  }

  signChallenge(challenge) {
    if (!challenge || typeof challenge.challenge_id !== "string" || typeof challenge.signed_message !== "string") throw new Error("invalid authentication challenge")
    return sign(null, Buffer.from(challenge.signed_message), this.privateKey).toString("base64url")
  }

  pairingPayload({displayName = "Simulated Chromium", scanningMode = "granted_sites"} = {}) {
    return {display_name: displayName, public_key: this.publicKeyEncoded, scanning_mode: scanningMode}
  }
}
