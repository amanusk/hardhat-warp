import { Account, Contract, ContractFactory as StarknetContractFactory, json } from 'starknet';
import {
  BigNumber,
  BytesLike,
  ContractFactory as EthersContractFactory,
  Signer,
  Contract as EthersContract,
} from 'ethers';
import { Interface } from '@ethersproject/abi';
import { TransactionRequest } from '@ethersproject/abstract-provider';
import { ContractInterface } from '@ethersproject/contracts';
import { WarpContract } from './Contract';
import { abiCoder, encode, SolValue } from '../transcode';
import { readFileSync } from 'fs';
import { WarpSigner } from './Signer';
import { benchmark, getContract, getContractsToDeclare } from '../utils';
import { getDefaultAccount, getSequencerProvider } from '../provider';

export class ContractFactory {
  readonly interface: Interface;
  readonly bytecode: string;
  readonly signer: Signer;
  pathToCairoFile: string;
  private sequencerProvider = getSequencerProvider();

  constructor(
    private starknetContractFactory: StarknetContractFactory,
    private ethersContractFactory: EthersContractFactory,
    pathToCairoFile: string,
  ) {
    this.interface = ethersContractFactory.interface;
    this.bytecode = ethersContractFactory.bytecode;
    this.signer = ethersContractFactory.signer; // Todo use starknet signers if possible
    this.pathToCairoFile = pathToCairoFile;
    // @ts-ignore
    this.interface._abiCoder = abiCoder;
  }

  // @TODO: Future; rename to populateTransaction?
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDeployTransaction(...args: Array<any>): TransactionRequest {
    console.warn(
      'getDeployTransaction not implemented for Starknet: using the Eth transaction instead',
    );
    return this.ethersContractFactory.getDeployTransaction(...args);
  }

  async deploy(...args: Array<SolValue>): Promise<EthersContract> {
    await Promise.all(
      Object.entries(getContractsToDeclare(this.pathToCairoFile)).map(
        async ([name, expected_hash]) => {
          const factory = await getStarknetContractFactory(name);

          const declareResponse =
            await this.starknetContractFactory.providerOrAccount.declareContract({
              contract: factory.compiledContract,
            });

          if (declareResponse.class_hash !== expected_hash) {
            throw new Error(
              `The hash of ${name} didn't match the hash expected by ${this.pathToCairoFile}\n` +
                `Please compile the solidity for ${this.pathToCairoFile} again or update the hash.\n` +
                `   ${name}'s expected hash: ${expected_hash}\n` +
                `   ${name}'s actuall hash:  ${declareResponse.class_hash}\n`,
            );
          }

          return this.starknetContractFactory.providerOrAccount.waitForTransaction(
            declareResponse.transaction_hash,
          );
        },
      ),
    );

    // Declare this contract
    const declareResponse = await this.starknetContractFactory.providerOrAccount.declareContract({
      contract: this.starknetContractFactory.compiledContract,
    });
    await this.starknetContractFactory.providerOrAccount.waitForTransaction(
      declareResponse.transaction_hash,
    );

    const inputs = encode(this.interface.deploy.inputs, args);

    const deployInputs = [
      declareResponse.class_hash,
      // using random salt, so that that the computed address is different each
      // time and starknet-devnet doesn't complain
      Math.floor(Math.random() * 1000000).toString(),
      inputs.length.toString(),
      ...inputs,
      '0',
    ];
    if (!(this.starknetContractFactory.providerOrAccount instanceof Account))
      throw new Error('Expect contract provider to be account');
    const { transaction_hash: deployTxHash } =
      await this.starknetContractFactory.providerOrAccount.execute({
        contractAddress: this.starknetContractFactory.providerOrAccount.address,
        calldata: deployInputs,
        entrypoint: 'deploy_contract',
      });
    await this.starknetContractFactory.providerOrAccount.waitForTransaction(deployTxHash);
    const txTrace = await this.sequencerProvider.getTransactionTrace(deployTxHash);
    benchmark(this.pathToCairoFile, 'constructor', txTrace);
    const deployAddress = txTrace.function_invocation.result[0];
    const starknetContract = new Contract(
      this.starknetContractFactory.abi,
      deployAddress,
      this.starknetContractFactory.providerOrAccount,
    );
    const contract = new WarpContract(
      starknetContract,
      this.ethersContractFactory,
      this.pathToCairoFile,
    );
    return contract;
  }

  attach(address: string): EthersContract {
    const starknetContract = this.starknetContractFactory.attach(address);
    const contract = new WarpContract(
      starknetContract,
      this.ethersContractFactory,
      this.pathToCairoFile,
    );
    return contract;
  }

  connect(account: WarpSigner): ContractFactory {
    this.starknetContractFactory.connect(account.starkNetSigner);
    this.starknetContractFactory.providerOrAccount = account.starkNetSigner;
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  static fromSolidity(compilerOutput: any, signer?: Signer): ContractFactory {
    throw new Error('fromSolidity not yet supported');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static getInterface(contractInterface: ContractInterface) {
    throw new Error('getInterface not yet supported');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static getContractAddress(tx: { from: string; nonce: BytesLike | BigNumber | number }): string {
    throw new Error('getContractAddress not supported');
  }

  static getContract(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    address: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    contractInterface: ContractInterface,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    signer?: Signer,
  ): EthersContract {
    throw new Error('getContract not supported');
  }
}

export async function getStarknetContractFactory(
  contractName: string,
): Promise<StarknetContractFactory> {
  const contract = getContract(contractName);
  const compiledContract = json.parse(readFileSync(contract.getCompiledJson()).toString('ascii'));
  return new StarknetContractFactory(
    compiledContract,
    await getDefaultAccount(),
    compiledContract.abi,
  );
}
