import type {
  OpenId4VciCreateCredentialResponseOptions,
  OpenId4VciCreateCredentialOfferOptions,
  OpenId4VciCreateIssuerOptions,
  OpenId4VciPreAuthorizedCodeFlowConfig,
  OpenId4VcIssuerMetadata,
  OpenId4VciSignSdJwtCredential,
  OpenId4VciSignW3cCredential,
  OpenId4VciSignMdocCredential,
} from './OpenId4VcIssuerServiceOptions'
import type { OpenId4VcIssuanceSessionRecord } from './repository'
import type {
  OpenId4VcCredentialHolderBinding,
  OpenId4VciCredentialConfigurationsSupported,
  OpenId4VciCredentialOfferPayload,
  OpenId4VciCredentialRequest,
} from '../shared'
import type { AgentContext, DidDocument, Key, Query, QueryOptions } from '@credo-ts/core'
import type {
  CredentialOfferPayloadV1_0_11,
  CredentialOfferPayloadV1_0_13,
  Grant,
  JWTVerifyCallback,
} from '@sphereon/oid4vci-common'
import type {
  CredentialDataSupplier,
  CredentialDataSupplierArgs,
  CredentialIssuanceInput,
  CredentialSignerCallback,
} from '@sphereon/oid4vci-issuer'
import type { ICredential } from '@sphereon/ssi-types'

import {
  SdJwtVcApi,
  CredoError,
  ClaimFormat,
  DidsApi,
  equalsIgnoreOrder,
  getJwkFromJson,
  getJwkFromKey,
  getKeyFromVerificationMethod,
  injectable,
  joinUriParts,
  JsonEncoder,
  JsonTransformer,
  JwsService,
  Jwt,
  KeyType,
  utils,
  W3cCredentialService,
  MdocApi,
  parseDid,
  DidResolverService,
} from '@credo-ts/core'
import { VcIssuerBuilder } from '@sphereon/oid4vci-issuer'

import { credentialsSupportedV11ToV13, OpenId4VciCredentialFormatProfile } from '../shared'
import { credentialsSupportedV13ToV11, getOfferedCredentials } from '../shared/issuerMetadataUtils'
import { storeActorIdForContextCorrelationId } from '../shared/router'
import { getSphereonVerifiableCredential } from '../shared/transform'
import { getProofTypeFromKey, isCredentialOfferV1Draft13 } from '../shared/utils'

import { OpenId4VcIssuanceSessionState } from './OpenId4VcIssuanceSessionState'
import { OpenId4VcIssuerModuleConfig } from './OpenId4VcIssuerModuleConfig'
import { OpenId4VcIssuerRepository, OpenId4VcIssuerRecord, OpenId4VcIssuanceSessionRepository } from './repository'
import { OpenId4VcCNonceStateManager } from './repository/OpenId4VcCNonceStateManager'
import { OpenId4VcCredentialOfferSessionStateManager } from './repository/OpenId4VcCredentialOfferSessionStateManager'
import { OpenId4VcCredentialOfferUriStateManager } from './repository/OpenId4VcCredentialOfferUriStateManager'
import { getCNonceFromCredentialRequest } from './util/credentialRequest'

const w3cOpenId4VcFormats = [
  OpenId4VciCredentialFormatProfile.JwtVcJson,
  OpenId4VciCredentialFormatProfile.JwtVcJsonLd,
  OpenId4VciCredentialFormatProfile.LdpVc,
]

/**
 * @internal
 */
@injectable()
export class OpenId4VcIssuerService {
  private w3cCredentialService: W3cCredentialService
  private jwsService: JwsService
  private openId4VcIssuerConfig: OpenId4VcIssuerModuleConfig
  private openId4VcIssuerRepository: OpenId4VcIssuerRepository
  private openId4VcIssuanceSessionRepository: OpenId4VcIssuanceSessionRepository

  public constructor(
    w3cCredentialService: W3cCredentialService,
    jwsService: JwsService,
    openId4VcIssuerConfig: OpenId4VcIssuerModuleConfig,
    openId4VcIssuerRepository: OpenId4VcIssuerRepository,
    openId4VcIssuanceSessionRepository: OpenId4VcIssuanceSessionRepository
  ) {
    this.w3cCredentialService = w3cCredentialService
    this.jwsService = jwsService
    this.openId4VcIssuerConfig = openId4VcIssuerConfig
    this.openId4VcIssuerRepository = openId4VcIssuerRepository
    this.openId4VcIssuanceSessionRepository = openId4VcIssuanceSessionRepository
  }

  public async createCredentialOffer(
    agentContext: AgentContext,
    options: OpenId4VciCreateCredentialOfferOptions & { issuer: OpenId4VcIssuerRecord }
  ) {
    const { preAuthorizedCodeFlowConfig, issuer, offeredCredentials } = options

    const vcIssuer = this.getVcIssuer(agentContext, issuer)

    if (options.preAuthorizedCodeFlowConfig.userPinRequired === false && options.preAuthorizedCodeFlowConfig.txCode) {
      throw new CredoError('The userPinRequired option must be set to true when using txCode.')
    }

    if (options.preAuthorizedCodeFlowConfig.userPinRequired && !options.preAuthorizedCodeFlowConfig.txCode) {
      options.preAuthorizedCodeFlowConfig.txCode = {}
    }

    if (options.preAuthorizedCodeFlowConfig.txCode && !options.preAuthorizedCodeFlowConfig.userPinRequired) {
      options.preAuthorizedCodeFlowConfig.userPinRequired = true
    }

    // this checks if the structure of the credentials is correct
    // it throws an error if a offered credential cannot be found in the credentialsSupported
    getOfferedCredentials(
      agentContext,
      options.offeredCredentials,
      vcIssuer.issuerMetadata.credential_configurations_supported
    )
    const uniqueOfferedCredentials = Array.from(new Set(options.offeredCredentials))
    if (uniqueOfferedCredentials.length !== offeredCredentials.length) {
      throw new CredoError('All offered credentials must have unique ids.')
    }

    // We always use shortened URIs currently
    const hostedCredentialOfferUri = joinUriParts(vcIssuer.issuerMetadata.credential_issuer, [
      this.openId4VcIssuerConfig.credentialOfferEndpoint.endpointPath,
      // It doesn't really matter what the url is, as long as it's unique
      utils.uuid(),
    ])

    const grants = await this.getGrantsFromConfig(agentContext, preAuthorizedCodeFlowConfig)

    let { uri } = await vcIssuer.createCredentialOfferURI({
      scheme: 'openid-credential-offer',
      grants,
      credential_configuration_ids: offeredCredentials,
      credentialOfferUri: hostedCredentialOfferUri,
      baseUri: options.baseUri,
      credentialDataSupplierInput: options.issuanceMetadata,
      pinLength: grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']?.tx_code?.length,
    })

    // FIXME: https://github.com/Sphereon-Opensource/OID4VCI/issues/102
    if (uri.includes(hostedCredentialOfferUri)) {
      uri = uri.replace(hostedCredentialOfferUri, encodeURIComponent(hostedCredentialOfferUri))
    }

    const issuanceSessionRepository = this.openId4VcIssuanceSessionRepository
    const issuanceSession = await issuanceSessionRepository.getSingleByQuery(agentContext, {
      credentialOfferUri: hostedCredentialOfferUri,
    })

    if (options.version !== 'v1.draft13') {
      const v13CredentialOfferPayload = issuanceSession.credentialOfferPayload as CredentialOfferPayloadV1_0_13
      const v11CredentialOfferPayload: CredentialOfferPayloadV1_0_11 = {
        ...v13CredentialOfferPayload,
        credentials: v13CredentialOfferPayload.credential_configuration_ids,
      }
      if (v11CredentialOfferPayload.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code']) {
        // property was always defined in v11
        v11CredentialOfferPayload.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'].user_pin_required =
          preAuthorizedCodeFlowConfig.userPinRequired ?? false
      }

      issuanceSession.credentialOfferPayload = v11CredentialOfferPayload
      await issuanceSessionRepository.update(agentContext, issuanceSession)
    }

    return {
      issuanceSession,
      credentialOffer: uri,
    }
  }

  /**
   * find the issuance session associated with a credential request. You can optionally provide a issuer id if
   * the issuer that the request is associated with is already known.
   */
  public async findIssuanceSessionForCredentialRequest(
    agentContext: AgentContext,
    { credentialRequest, issuerId }: { credentialRequest: OpenId4VciCredentialRequest; issuerId?: string }
  ) {
    const cNonce = getCNonceFromCredentialRequest(credentialRequest)

    const issuanceSession = await this.openId4VcIssuanceSessionRepository.findSingleByQuery(agentContext, {
      issuerId,
      cNonce,
    })

    return issuanceSession
  }

  public async createCredentialResponse(
    agentContext: AgentContext,
    options: OpenId4VciCreateCredentialResponseOptions & { issuanceSession: OpenId4VcIssuanceSessionRecord }
  ) {
    options.issuanceSession.assertState([
      OpenId4VcIssuanceSessionState.AccessTokenCreated,
      OpenId4VcIssuanceSessionState.CredentialRequestReceived,
      // It is possible to issue multiple credentials in one session
      OpenId4VcIssuanceSessionState.CredentialsPartiallyIssued,
    ])
    const { credentialRequest, issuanceSession } = options
    if (!credentialRequest.proof) throw new CredoError('No proof defined in the credentialRequest.')

    const issuer = await this.getIssuerByIssuerId(agentContext, options.issuanceSession.issuerId)

    const cNonce = getCNonceFromCredentialRequest(credentialRequest)
    if (issuanceSession.cNonce !== cNonce) {
      throw new CredoError('The cNonce in the credential request does not match the cNonce in the issuance session.')
    }

    if (!issuanceSession.cNonceExpiresAt) {
      throw new CredoError('Missing required cNonceExpiresAt in the issuance session. Assuming cNonce is not valid')
    }
    if (Date.now() > issuanceSession.cNonceExpiresAt.getTime()) {
      throw new CredoError('The cNonce has expired.')
    }

    const vcIssuer = this.getVcIssuer(agentContext, issuer)

    const credentialResponse = await vcIssuer.issueCredential({
      credentialRequest,
      tokenExpiresIn: this.openId4VcIssuerConfig.accessTokenEndpoint.tokenExpiresInSeconds,

      // This can just be combined with signing callback right?
      credentialDataSupplier: this.getCredentialDataSupplier(agentContext, { ...options, issuer }),
      credentialDataSupplierInput: issuanceSession.issuanceMetadata,
      responseCNonce: undefined,
    })

    // NOTE: ONLY REQUIRED FOR V11 COMPAT
    if (isCredentialOfferV1Draft13(options.issuanceSession.credentialOfferPayload)) {
      credentialResponse.format = credentialRequest.format
    }

    const updatedIssuanceSession = await this.openId4VcIssuanceSessionRepository.getById(
      agentContext,
      issuanceSession.id
    )
    if (!credentialResponse.credential) {
      updatedIssuanceSession.state = OpenId4VcIssuanceSessionState.Error
      updatedIssuanceSession.errorMessage = 'No credential found in the issueCredentialResponse.'
      await this.openId4VcIssuanceSessionRepository.update(agentContext, updatedIssuanceSession)
      throw new CredoError(updatedIssuanceSession.errorMessage)
    }

    if (credentialResponse.acceptance_token || credentialResponse.transaction_id) {
      updatedIssuanceSession.state = OpenId4VcIssuanceSessionState.Error
      updatedIssuanceSession.errorMessage = 'Acceptance token and transaction id are not yet supported.'
      await this.openId4VcIssuanceSessionRepository.update(agentContext, updatedIssuanceSession)
      throw new CredoError(updatedIssuanceSession.errorMessage)
    }

    return {
      credentialResponse,
      issuanceSession: updatedIssuanceSession,
    }
  }

  public async findIssuanceSessionsByQuery(
    agentContext: AgentContext,
    query: Query<OpenId4VcIssuanceSessionRecord>,
    queryOptions?: QueryOptions
  ) {
    return this.openId4VcIssuanceSessionRepository.findByQuery(agentContext, query, queryOptions)
  }

  public async getIssuanceSessionById(agentContext: AgentContext, issuanceSessionId: string) {
    return this.openId4VcIssuanceSessionRepository.getById(agentContext, issuanceSessionId)
  }

  public async getAllIssuers(agentContext: AgentContext) {
    return this.openId4VcIssuerRepository.getAll(agentContext)
  }

  public async getIssuerByIssuerId(agentContext: AgentContext, issuerId: string) {
    return this.openId4VcIssuerRepository.getByIssuerId(agentContext, issuerId)
  }

  public async updateIssuer(agentContext: AgentContext, issuer: OpenId4VcIssuerRecord) {
    return this.openId4VcIssuerRepository.update(agentContext, issuer)
  }

  public async createIssuer(agentContext: AgentContext, options: OpenId4VciCreateIssuerOptions) {
    // TODO: ideally we can store additional data with a key, such as:
    // - createdAt
    // - purpose
    const accessTokenSignerKey = await agentContext.wallet.createKey({
      keyType: KeyType.Ed25519,
    })

    const openId4VcIssuerBase = {
      issuerId: options.issuerId ?? utils.uuid(),
      display: options.display,
      dpopSigningAlgValuesSupported: options.dpopSigningAlgValuesSupported,
      accessTokenPublicKeyFingerprint: accessTokenSignerKey.fingerprint,
    } as const

    const openId4VcIssuer = options.credentialsSupported
      ? new OpenId4VcIssuerRecord({
          ...openId4VcIssuerBase,
          credentialsSupported: options.credentialsSupported,
        })
      : new OpenId4VcIssuerRecord({
          ...openId4VcIssuerBase,
          credentialConfigurationsSupported: options.credentialConfigurationsSupported,
        })

    await this.openId4VcIssuerRepository.save(agentContext, openId4VcIssuer)
    await storeActorIdForContextCorrelationId(agentContext, openId4VcIssuer.issuerId)
    return openId4VcIssuer
  }

  public async rotateAccessTokenSigningKey(agentContext: AgentContext, issuer: OpenId4VcIssuerRecord) {
    const accessTokenSignerKey = await agentContext.wallet.createKey({
      keyType: KeyType.Ed25519,
    })

    // TODO: ideally we can remove the previous key
    issuer.accessTokenPublicKeyFingerprint = accessTokenSignerKey.fingerprint
    await this.openId4VcIssuerRepository.update(agentContext, issuer)
  }

  public getIssuerMetadata(agentContext: AgentContext, issuerRecord: OpenId4VcIssuerRecord): OpenId4VcIssuerMetadata {
    const config = agentContext.dependencyManager.resolve(OpenId4VcIssuerModuleConfig)
    const issuerUrl = joinUriParts(config.baseUrl, [issuerRecord.issuerId])

    const issuerMetadata = {
      issuerUrl,
      tokenEndpoint: joinUriParts(issuerUrl, [config.accessTokenEndpoint.endpointPath]),
      credentialEndpoint: joinUriParts(issuerUrl, [config.credentialEndpoint.endpointPath]),
      credentialsSupported: issuerRecord.credentialsSupported,
      credentialConfigurationsSupported:
        issuerRecord.credentialConfigurationsSupported ??
        credentialsSupportedV11ToV13(agentContext, issuerRecord.credentialsSupported),
      issuerDisplay: issuerRecord.display,
      dpopSigningAlgValuesSupported: issuerRecord.dpopSigningAlgValuesSupported,
    } satisfies OpenId4VcIssuerMetadata

    return issuerMetadata
  }

  private getJwtVerifyCallback = (agentContext: AgentContext): JWTVerifyCallback<DidDocument> => {
    return async (opts) => {
      let didDocument = undefined as DidDocument | undefined
      const { isValid, jws } = await this.jwsService.verifyJws(agentContext, {
        jws: opts.jwt,
        // Only handles kid as did resolution. JWK is handled by jws service
        jwkResolver: async ({ protectedHeader: { kid } }) => {
          if (!kid) throw new CredoError('Missing kid in protected header.')
          if (!kid.startsWith('did:')) throw new CredoError('Only did is supported for kid identifier')

          const didsApi = agentContext.dependencyManager.resolve(DidsApi)
          didDocument = await didsApi.resolveDidDocument(kid)
          const verificationMethod = didDocument.dereferenceKey(kid, ['authentication', 'assertionMethod'])
          const key = getKeyFromVerificationMethod(verificationMethod)
          return getJwkFromKey(key)
        },
      })

      if (!isValid) throw new CredoError('Could not verify JWT signature.')

      // TODO: the jws service should return some better decoded metadata also from the resolver
      // as currently is less useful if you afterwards need properties from the JWS
      const firstJws = jws.signatures[0]
      const protectedHeader = JsonEncoder.fromBase64(firstJws.protected)
      return {
        jwt: { header: protectedHeader, payload: JsonEncoder.fromBase64(jws.payload) },
        kid: protectedHeader.kid,
        jwk: protectedHeader.jwk ? getJwkFromJson(protectedHeader.jwk) : undefined,
        did: didDocument?.id,
        alg: protectedHeader.alg,
        didDocument,
      }
    }
  }

  private getVcIssuer(agentContext: AgentContext, issuer: OpenId4VcIssuerRecord) {
    const issuerMetadata = this.getIssuerMetadata(agentContext, issuer)

    const builder = new VcIssuerBuilder()
      .withCredentialIssuer(issuerMetadata.issuerUrl)
      .withCredentialEndpoint(issuerMetadata.credentialEndpoint)
      .withTokenEndpoint(issuerMetadata.tokenEndpoint)
      .withCredentialConfigurationsSupported(
        issuer.credentialConfigurationsSupported ??
          credentialsSupportedV11ToV13(agentContext, issuer.credentialsSupported)
      )
      .withCNonceStateManager(new OpenId4VcCNonceStateManager(agentContext, issuer.issuerId))
      .withCredentialOfferStateManager(new OpenId4VcCredentialOfferSessionStateManager(agentContext, issuer.issuerId))
      .withCredentialOfferURIStateManager(new OpenId4VcCredentialOfferUriStateManager(agentContext, issuer.issuerId))
      .withJWTVerifyCallback(this.getJwtVerifyCallback(agentContext))
      .withCredentialSignerCallback(() => {
        throw new CredoError('Credential signer callback should be overwritten. This is a no-op')
      })

    if (issuerMetadata.authorizationServer) {
      builder.withAuthorizationServers(issuerMetadata.authorizationServer)
    }

    if (issuerMetadata.issuerDisplay) {
      builder.withIssuerDisplay(issuerMetadata.issuerDisplay)
    }

    return builder.build()
  }

  private async getGrantsFromConfig(
    agentContext: AgentContext,
    preAuthorizedCodeFlowConfig: OpenId4VciPreAuthorizedCodeFlowConfig
  ) {
    const grants: Grant = {
      'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
        'pre-authorized_code':
          preAuthorizedCodeFlowConfig.preAuthorizedCode ?? (await agentContext.wallet.generateNonce()),
        // v11 only
        user_pin_required: preAuthorizedCodeFlowConfig.userPinRequired ?? false,
        tx_code: preAuthorizedCodeFlowConfig.txCode,
      },
    }

    return grants
  }

  private findOfferedCredentialsMatchingRequest(
    agentContext: AgentContext,
    credentialOffer: OpenId4VciCredentialOfferPayload,
    credentialRequest: OpenId4VciCredentialRequest,
    allCredentialConfigurationsSupported: OpenId4VciCredentialConfigurationsSupported,
    issuanceSession: OpenId4VcIssuanceSessionRecord
  ): OpenId4VciCredentialConfigurationsSupported {
    const offeredCredentialsData = isCredentialOfferV1Draft13(credentialOffer)
      ? credentialOffer.credential_configuration_ids
      : credentialOffer.credentials

    const { credentialConfigurationsSupported: offeredCredentialConfigurations } = getOfferedCredentials(
      agentContext,
      offeredCredentialsData,
      allCredentialConfigurationsSupported
    )

    if ('credential_identifier' in credentialRequest && typeof credentialRequest.credential_identifier === 'string') {
      const offeredCredential = offeredCredentialConfigurations[credentialRequest.credential_identifier]
      if (!offeredCredential) {
        throw new CredoError(
          `Requested credential with id '${credentialRequest.credential_identifier}' was not offered.`
        )
      }

      return {
        [credentialRequest.credential_identifier]: offeredCredential,
      }
    }

    return Object.fromEntries(
      Object.entries(offeredCredentialConfigurations).filter(([id, offeredCredential]) => {
        if (offeredCredential.format !== credentialRequest.format) return false
        if (issuanceSession.issuedCredentials.includes(id)) return false

        if (
          credentialRequest.format === OpenId4VciCredentialFormatProfile.JwtVcJson &&
          offeredCredential.format === credentialRequest.format
        ) {
          const types =
            'credential_definition' in credentialRequest
              ? credentialRequest.credential_definition.type
              : credentialRequest.types

          return equalsIgnoreOrder(offeredCredential.credential_definition.type ?? [], types)
        } else if (
          credentialRequest.format === OpenId4VciCredentialFormatProfile.JwtVcJsonLd &&
          offeredCredential.format === credentialRequest.format
        ) {
          const types =
            'type' in credentialRequest.credential_definition
              ? credentialRequest.credential_definition.type
              : credentialRequest.credential_definition.types

          return equalsIgnoreOrder(offeredCredential.credential_definition.type ?? [], types)
        } else if (
          credentialRequest.format === OpenId4VciCredentialFormatProfile.LdpVc &&
          offeredCredential.format === credentialRequest.format
        ) {
          const types =
            'type' in credentialRequest.credential_definition
              ? credentialRequest.credential_definition.type
              : credentialRequest.credential_definition.types

          return equalsIgnoreOrder(offeredCredential.credential_definition.type ?? [], types)
        } else if (
          credentialRequest.format === OpenId4VciCredentialFormatProfile.SdJwtVc &&
          offeredCredential.format === credentialRequest.format
        ) {
          return offeredCredential.vct === credentialRequest.vct
        } else if (
          credentialRequest.format === OpenId4VciCredentialFormatProfile.MsoMdoc &&
          offeredCredential.format === credentialRequest.format
        ) {
          return offeredCredential.doctype === credentialRequest.doctype
        }

        return false
      })
    )
  }

  private getSdJwtVcCredentialSigningCallback = (
    agentContext: AgentContext,
    options: OpenId4VciSignSdJwtCredential
  ): CredentialSignerCallback<DidDocument> => {
    return async () => {
      const sdJwtVcApi = agentContext.dependencyManager.resolve(SdJwtVcApi)

      const sdJwtVc = await sdJwtVcApi.sign(options)
      return getSphereonVerifiableCredential(sdJwtVc)
    }
  }

  private getMsoMdocCredentialSigningCallback = (
    agentContext: AgentContext,
    options: OpenId4VciSignMdocCredential
  ): CredentialSignerCallback<DidDocument> => {
    return async () => {
      const mdocApi = agentContext.dependencyManager.resolve(MdocApi)

      const mdoc = await mdocApi.sign(options)
      return getSphereonVerifiableCredential(mdoc)
    }
  }

  private getW3cCredentialSigningCallback = (
    agentContext: AgentContext,
    options: OpenId4VciSignW3cCredential
  ): CredentialSignerCallback<DidDocument> => {
    return async (opts) => {
      const { jwtVerifyResult, format } = opts
      const { kid, didDocument: holderDidDocument } = jwtVerifyResult

      if (!kid) throw new CredoError('Missing Kid. Cannot create the holder binding')
      if (!holderDidDocument) throw new CredoError('Missing did document. Cannot create the holder binding.')
      if (!format) throw new CredoError('Missing format. Cannot issue credential.')

      const formatMap: Record<string, ClaimFormat.JwtVc | ClaimFormat.LdpVc> = {
        [OpenId4VciCredentialFormatProfile.JwtVcJson]: ClaimFormat.JwtVc,
        [OpenId4VciCredentialFormatProfile.JwtVcJsonLd]: ClaimFormat.JwtVc,
        [OpenId4VciCredentialFormatProfile.LdpVc]: ClaimFormat.LdpVc,
      }
      const w3cServiceFormat = formatMap[format]

      // Set the binding on the first credential subject if not set yet
      // on any subject
      if (!options.credential.credentialSubjectIds.includes(holderDidDocument.id)) {
        const credentialSubject = Array.isArray(options.credential.credentialSubject)
          ? options.credential.credentialSubject[0]
          : options.credential.credentialSubject
        credentialSubject.id = holderDidDocument.id
      }

      const didsApi = agentContext.dependencyManager.resolve(DidsApi)
      const issuerDidDocument = await didsApi.resolveDidDocument(options.verificationMethod)
      const verificationMethod = issuerDidDocument.dereferenceVerificationMethod(options.verificationMethod)

      if (w3cServiceFormat === ClaimFormat.JwtVc) {
        const key = getKeyFromVerificationMethod(verificationMethod)
        const supportedSignatureAlgorithms = getJwkFromKey(key).supportedSignatureAlgorithms
        if (supportedSignatureAlgorithms.length === 0) {
          throw new CredoError(`No supported JWA signature algorithms found for key with keyType ${key.keyType}`)
        }
        const alg = supportedSignatureAlgorithms[0]

        if (!alg) {
          throw new CredoError(`No supported JWA signature algorithms for key type ${key.keyType}`)
        }

        const signed = await this.w3cCredentialService.signCredential(agentContext, {
          format: w3cServiceFormat,
          credential: options.credential,
          verificationMethod: options.verificationMethod,
          alg,
        })

        return getSphereonVerifiableCredential(signed)
      } else {
        const key = getKeyFromVerificationMethod(verificationMethod)
        const proofType = getProofTypeFromKey(agentContext, key)

        const signed = await this.w3cCredentialService.signCredential(agentContext, {
          format: w3cServiceFormat,
          credential: options.credential,
          verificationMethod: options.verificationMethod,
          proofType: proofType,
        })

        return getSphereonVerifiableCredential(signed)
      }
    }
  }

  private async getHolderBindingFromRequest(
    agentContext: AgentContext,
    credentialRequest: OpenId4VciCredentialRequest
  ) {
    if (!credentialRequest.proof?.jwt) throw new CredoError('Received a credential request without a proof')

    const jwt = Jwt.fromSerializedJwt(credentialRequest.proof.jwt)

    if (jwt.header.kid) {
      if (!jwt.header.kid.startsWith('did:')) {
        throw new CredoError("Only did is supported for 'kid' identifier")
      } else if (!jwt.header.kid.includes('#')) {
        throw new CredoError(
          `kid containing did MUST point to a specific key within the did document: ${jwt.header.kid}`
        )
      }

      const parsedDid = parseDid(jwt.header.kid)
      if (!parsedDid.fragment) {
        throw new Error(`didUrl '${parsedDid.didUrl}' does not contain a '#'. Unable to derive key from did document.`)
      }

      const didResolver = agentContext.dependencyManager.resolve(DidResolverService)
      const didDocument = await didResolver.resolveDidDocument(agentContext, parsedDid.didUrl)
      const key = getKeyFromVerificationMethod(didDocument.dereferenceKey(parsedDid.didUrl, ['assertionMethod']))

      return {
        method: 'did',
        didUrl: jwt.header.kid,
        key,
      } satisfies OpenId4VcCredentialHolderBinding & { key: Key }
    } else if (jwt.header.jwk) {
      const jwk = getJwkFromJson(jwt.header.jwk)
      return {
        method: 'jwk',
        jwk: jwk,
        key: jwk.key,
      } satisfies OpenId4VcCredentialHolderBinding & { key: Key }
    } else {
      throw new CredoError('Either kid or jwk must be present in credential request proof header')
    }
  }

  private getCredentialDataSupplier = (
    agentContext: AgentContext,
    options: OpenId4VciCreateCredentialResponseOptions & {
      issuer: OpenId4VcIssuerRecord
      issuanceSession: OpenId4VcIssuanceSessionRecord
    }
  ): CredentialDataSupplier => {
    return async (args: CredentialDataSupplierArgs) => {
      const { issuanceSession, issuer } = options

      const credentialRequest = args.credentialRequest as OpenId4VciCredentialRequest

      const issuerMetadata = this.getIssuerMetadata(agentContext, issuer)

      const offeredCredentialsMatchingRequest = this.findOfferedCredentialsMatchingRequest(
        agentContext,
        options.issuanceSession.credentialOfferPayload,
        credentialRequest,
        issuerMetadata.credentialConfigurationsSupported,
        issuanceSession
      )

      const numOfferedCredentialsMatchingRequest = Object.keys(offeredCredentialsMatchingRequest).length
      if (numOfferedCredentialsMatchingRequest === 0) {
        throw new CredoError('No offered credentials match the credential request.')
      }

      if (numOfferedCredentialsMatchingRequest > 1) {
        agentContext.config.logger.debug(
          'Multiple credentials from credentials supported matching request, picking first one.'
        )
      }

      const mapper =
        options.credentialRequestToCredentialMapper ??
        this.openId4VcIssuerConfig.credentialEndpoint.credentialRequestToCredentialMapper

      const credentialConfigurationIds = Object.entries(offeredCredentialsMatchingRequest).map(
        ([credentialConfigurationId]) => credentialConfigurationId
      ) as [string, ...string[]]

      const holderBinding = await this.getHolderBindingFromRequest(agentContext, credentialRequest)
      const signOptions = await mapper({
        agentContext,
        issuanceSession,
        holderBinding,
        credentialOffer: { credential_offer: issuanceSession.credentialOfferPayload },
        credentialRequest: credentialRequest,
        credentialsSupported: credentialsSupportedV13ToV11(offeredCredentialsMatchingRequest),
        credentialConfigurationIds,
      })

      const credentialHasAlreadyBeenIssued = issuanceSession.issuedCredentials.includes(
        signOptions.credentialSupportedId
      )
      if (credentialHasAlreadyBeenIssued) {
        throw new CredoError(
          `The requested credential with id '${signOptions.credentialSupportedId}' has already been issued.`
        )
      }

      const updatedIssuanceSession = await this.openId4VcIssuanceSessionRepository.getById(
        agentContext,
        issuanceSession.id
      )
      updatedIssuanceSession.issuedCredentials.push(signOptions.credentialSupportedId)
      await this.openId4VcIssuanceSessionRepository.update(agentContext, updatedIssuanceSession)

      if (signOptions.format === ClaimFormat.JwtVc || signOptions.format === ClaimFormat.LdpVc) {
        if (!w3cOpenId4VcFormats.includes(credentialRequest.format as OpenId4VciCredentialFormatProfile)) {
          throw new CredoError(
            `The credential to be issued does not match the request. Cannot issue a W3cCredential if the client expects a credential of format '${credentialRequest.format}'.`
          )
        }

        return {
          format: credentialRequest.format,
          credential: JsonTransformer.toJSON(signOptions.credential) as ICredential,
          signCallback: this.getW3cCredentialSigningCallback(agentContext, signOptions),
        }
      } else if (signOptions.format === ClaimFormat.SdJwtVc) {
        if (credentialRequest.format !== OpenId4VciCredentialFormatProfile.SdJwtVc) {
          throw new CredoError(
            `Invalid credential format. Expected '${OpenId4VciCredentialFormatProfile.SdJwtVc}', received '${credentialRequest.format}'.`
          )
        }
        if (credentialRequest.vct !== signOptions.payload.vct) {
          throw new CredoError(
            `The types of the offered credentials do not match the types of the requested credential. Offered '${signOptions.payload.vct}' Requested '${credentialRequest.vct}'.`
          )
        }

        return {
          format: credentialRequest.format,
          // NOTE: we don't use the credential value here as we pass the credential directly to the singer
          credential: { ...signOptions.payload } as unknown as CredentialIssuanceInput,
          signCallback: this.getSdJwtVcCredentialSigningCallback(agentContext, signOptions),
        }
      } else if (signOptions.format === ClaimFormat.MsoMdoc) {
        if (credentialRequest.format !== OpenId4VciCredentialFormatProfile.MsoMdoc) {
          throw new CredoError(
            `Invalid credential format. Expected '${OpenId4VciCredentialFormatProfile.MsoMdoc}', received '${credentialRequest.format}'.`
          )
        }

        if (credentialRequest.doctype !== signOptions.docType) {
          throw new CredoError(
            `The types of the offered credentials do not match the types of the requested credential. Offered '${signOptions.docType}' Requested '${credentialRequest.doctype}'.`
          )
        }

        return {
          format: credentialRequest.format,
          // NOTE: we don't use the credential value here as we pass the credential directly to the singer
          credential: { ...signOptions.namespaces, docType: signOptions.docType } as unknown as CredentialIssuanceInput,
          signCallback: this.getMsoMdocCredentialSigningCallback(agentContext, signOptions),
        }
      } else {
        throw new CredoError(`Unsupported credential format ${signOptions.format}`)
      }
    }
  }
}
