# Detecção de encontros

Aplicação de linha de comando em JavaScript para detectar encontros entre pessoas a partir de posições geográficas. Compara registros de um mesmo timestamp, calcula a distância por Haversine e gera um array JSON determinístico com os pares a menos de 20 metros.

Usa Node.js 22 ou superior, módulos ES e uma única thread. Não exige dependências, instalação de pacotes nem etapa de build.

## Como executar

Confira a versão do Node e crie o diretório de saída, caso ele ainda não exista. No PowerShell:

```powershell
node --version
New-Item -ItemType Directory -Force outputs
npm run detect -- data/dataset1.txt outputs/dataset1.json
```

Em Linux ou macOS, crie o diretório com `mkdir -p outputs` e use o mesmo comando npm. A aplicação de detecção usa apenas APIs do Node; o monitor externo do benchmark foi implementado para Windows.

Para escolher o caminho do log de rejeições:

```text
npm run detect -- data/dataset1.txt outputs/dataset1.json --rejects outputs/rejeicoes.jsonl
```

`--rejects` é a única opção da aplicação. Os diretórios de destino devem existir. Entrada, saída e log precisam ter caminhos resolvidos distintos. Para processar vários datasets, execute o comando uma vez para cada arquivo.

Os arquivos `.txt` de entrada não acompanham o ZIP. Coloque-os em `data/`. Os gabaritos oficiais dos datasets 1 e 2 estão no pacote, assim como suas cópias em `test/fixtures/`.

## Entrada

O cabeçalho deve ser exatamente:

```text
idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida
```

Os registros usam `;` como separador. Timestamp e lista de restrições aceitam um par opcional de aspas duplas. O timestamp tem formato `YYYY-MM-DD HH:MM:SS`, com calendário gregoriano validado sem `Date`. Coordenadas usam ponto decimal e de uma a cinco casas; IDs são inteiros não negativos seguros do JavaScript. Nenhum campo numérico, booleano ou de timestamp recebe `trim` ou correção automática.

O leitor aceita BOM UTF-8 antes do cabeçalho, quebras LF ou CRLF e última linha sem quebra. A facção é um token opaco: comparação byte a byte, sem normalização. Um arquivo só com cabeçalho válido produz `[]`; um arquivo vazio é fatal.

## Regras e saída

Regras confirmadas pelo enunciado, conforme registradas em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):

- Comparar somente timestamps exatamente iguais, sem arredondamento temporal.
- Usar Haversine com raio de 6.371.000 metros e distância **estritamente menor que 20 metros**.
- Emitir no máximo um encontro por par não ordenado de IDs distintos em cada timestamp.
- Preservar as posições e a distância sem arredondamento no contrato JSON.

A classificação usa prioridade `protetiva` > `faccao` > `generico`, sustentada pelos gabaritos 1 e 2. `protetiva` exige uma vítima cuja restrição contenha o outro participante, que não pode ser vítima. `faccao` exige facções iguais e não vazias. Os demais pares qualificados são `generico`; a interpretação dos pares com vítima está destacada em A1 abaixo.

Exemplo real do gabarito do dataset 1:

```json
{
  "tipo": "faccao",
  "monitoradosEncontro": [7, 8],
  "timestamp": "2024-01-01 00:36:00",
  "posicoes": {
    "7": { "lat": -13.02054, "lon": -46.40609 },
    "8": { "lat": -13.02046, "lon": -46.40609 }
  },
  "distanciaMetros": 8.895594131622975
}
```

O arquivo contém um array desses objetos, formatado com dois espaços. Os IDs de cada par ficam em ordem crescente; dentro de cada timestamp, os encontros são ordenados pelos dois IDs. A entrada ordenada determina a ordem cronológica global. A ausência de encontros produz `[]`.

## Algoritmo e decisões de implementação

1. Ler com `fs.readSync` em um `Buffer` reutilizável de 4 MiB. Localizar quebras com `Buffer.indexOf`; preservar o fragmento final e aumentar o buffer se uma linha não couber.
2. Interpretar os campos diretamente dos bytes, sem criar uma string ou objeto para cada linha no caminho comum. Validar todos os campos antes de verificar ordem e duplicatas. Confirmar alterações no cache apenas ao aceitar o registro.
3. Manter um grupo de timestamp em arrays tipados: `Float64Array` para IDs e `Int32Array` para coordenadas multiplicadas por 100.000. Cada posição referencia seu snapshot de metadados. O cache guarda cópias dos bytes; não guarda fatias do buffer de leitura.
4. Processar o grupo concluído de forma síncrona antes de aceitar o próximo registro. Ordenar índices por latitude com insertion sort, reaproveitando a ordem anterior. Reiniciar a ordem quando o tamanho ou a sequência de IDs mudar. A área de trabalho copia os IDs e não retém os arrays do leitor.
5. Varrer candidatos enquanto a diferença de latitude escalada for no máximo 18. Essa janela corresponde a cerca de 20,0151 m em latitude, portanto não elimina um encontro possível abaixo de 20 m. Longitude, polos e antimeridiano são decididos pela distância exata.
6. Calcular Haversine com as coordenadas divididas por `1e5`, colocando o menor ID no primeiro ponto. A fórmula converte a diferença em graus antes de aplicar seno, cosseno e `asin`, preservando a variante numérica dos exemplos oficiais.
7. Classificar, ordenar os encontros do grupo e copiar seus valores para a saída. Acumular os encontros, serializar em temporário e publicar por renomeação somente após o sucesso completo.

O timestamp do grupo aceito também funciona como referência já validada: bytes internos iguais dispensam repetir o calendário e a comparação de ordem. Valores alterados são revalidados; registros rejeitados não atualizam essa referência.

Com `k` posições em um grupo, a varredura pode examinar até `k(k-1)/2` pares. Insertion sort também pode custar `O(k²)` quando a ordem muda muito, inclusive em ordem inversa. O reaproveitamento favorece grupos cuja ordem muda pouco; **não há promessa de complexidade linear**. Há testes de tamanhos e IDs variáveis e de ordem inversa.

A memória depende do buffer e da maior linha, do maior grupo, dos metadados dos IDs já vistos e dos encontros acumulados. O arquivo inteiro nunca é convertido em string. A saída em memória é uma escolha para os poucos encontros observados; cerca de 100.000 encontros ou pressão de memória exigem reavaliar a escrita, conforme a arquitetura.

## Premissas e limitações

Estas decisões são separadas das regras confirmadas. O registro completo está na seção 6 da arquitetura.

| Premissa | Decisão adotada e consequência |
|---|---|
| A1 — pares com vítima sem relação protetiva | Vítima × não agressor e vítima × vítima podem ser `generico`, depois da prioridade de facção. É uma interpretação não confirmada. Fica isolada em `GENERIC_WITH_VICTIM_TYPE` e é acompanhada por `genericWithVictim`. |
| A2 — prioridade e unicidade | `protetiva` > `faccao` > `generico`, um encontro por par e timestamp. Sustentada pelos gabaritos 1 e 2. |
| A3 — dado inválido | Rejeitar, registrar e continuar. Pode perder encontros da linha; o log permite revisar a origem. |
| A4 — duplicatas | Vale o primeiro registro aceito. Tanto a duplicata idêntica quanto a conflitante são rejeitadas e registradas. |
| A5 — ordenação | Os timestamps válidos devem ser não decrescentes. Registros anteriores são rejeitados; não há ordenação externa nem reconstrução de grupos já fechados. |
| A6 — precisão de coordenadas | Aceitar de uma a cinco casas decimais; o inteiro escalado continua exato. |
| A7 — faixa de IDs | Aceitar de zero até `Number.MAX_SAFE_INTEGER` (9.007.199.254.740.991). Valores maiores não são representáveis exatamente como número JSON e são rejeitados. |
| A8 — identidade de facção | Comparar bytes sem normalizar. Por exemplo, `01` e `1` são facções diferentes; duas facções vazias não casam. |

A5 é uma premissa de implementação, não uma garantia do enunciado. Ao atingir 1.000 rejeições `out-of-order-timestamp` consecutivas, a execução aborta. Um registro aceito zera o contador; rejeições por outros motivos não o alteram. A mensagem identifica a primeira linha da sequência e a linha em que o grupo atual começou.

Existe uma lacuna conhecida: um timestamp futuro errado perto do fim do arquivo pode deixar menos de 1.000 linhas anteriores para rejeitar. Nesse caso a execução termina com código 0 e perde os encontros dessas linhas. O aviso e o log tornam isso visível; por isso conferir rejeições faz parte da entrega.

## Erros e conferência da execução

| Código de saída | Significado |
|---|---|
| `0` | A saída foi publicada. Ainda pode haver linhas rejeitadas que precisam de revisão. |
| `1` | Erro fatal: o resultado da execução não serve para entrega. Uma saída anterior permanece intacta e o temporário é removido. |

Erros fatais incluem argumentos inválidos, entrada ilegível, cabeçalho incorreto, arquivo vazio, colisão de caminhos, falha de escrita, sequência sistemática fora de ordem e erro interno inesperado.

O resumo sempre vai para `stderr`: linhas, registros aceitos, rejeições por motivo, mudanças de metadados, grupos, encontros por tipo, `genericWithVictim`, tempos e informações de CPU/memória. `detection` contém as subetapas `sortAndScan` e `haversineAndClassification`; esses tempos não devem ser somados duas vezes.

O log padrão é `<saída>.rejects.jsonl`. Um log anterior é removido no início da execução; um novo só é criado na primeira rejeição. Cada linha registra `line`, `reason` e até 200 caracteres de `raw`. O motivo é o primeiro campo inválido na ordem das colunas; defeitos de formato precedem a checagem de ordem.

Antes de entregar um resultado: confira o código de saída, o resumo e a existência do log. Sem rejeições, prossiga. Com rejeições, revise todas: dado sujo pode justificar o resultado parcial, mas um defeito do parser exige correção e nova execução. Código 1 exige resolver a falha antes de usar o resultado.

## Testes e resultados finais

```text
npm test
npm run verify
```

`npm test` usa `node:test`. Um teste de integração injeta linhas ruins no dataset 2 real; portanto, requer `data/dataset2.txt`. `npm run verify` requer os datasets 1 e 2 e seus gabaritos em `data/`.

Na validação final, **104 testes passaram no Node 22.22.2**. A cobertura inclui as dez distâncias oficiais, oráculo em 4.000 grupos sintéticos, tamanhos e IDs variáveis, ordem inversa, buffers e leituras de 1/7/64 bytes com saída idêntica, BOM, CRLF, aspas opcionais, calendário, precisão, todos os motivos de rejeição, metadados, ordenação e preservação da saída em falhas.

Um único teste de ambiente exige igualdade exata `===` nas dez distâncias oficiais; os demais testes numéricos usam tolerância de `1e-9` m. Funções trigonométricas podem variar entre versões e plataformas: a igualdade exata observada não é uma garantia de portabilidade e não autoriza alterar os gabaritos.

Todos os arquivos abaixo foram processados integralmente em Node 22.22.2, com código 0, **zero rejeições, nenhum log de rejeições e `genericWithVictim = 0`**:

| Dataset | Registros aceitos | Protetiva | Facção | Genérico | Total | Referência de correção |
|---|---:|---:|---:|---:|---:|---|
| 1 | 5.000 | 1 | 1 | 2 | 4 | Gabarito oficial reproduzido |
| 2 | 25.000 | 1 | 2 | 3 | 6 | Gabarito oficial reproduzido |
| 3 | 100.000 | 2 | 3 | 5 | 10 | Previsão independente, não oficial |
| 4 | 400.020 | 3 | 5 | 7 | 15 | Previsão independente, não oficial |
| 5 | 1.000.000 | 4 | 7 | 10 | 21 | Previsão independente, não oficial |
| 6 | 8.000.000 | 6 | 9 | 12 | 27 | Previsão independente, não oficial |
| 7 | 12.000.000 | 8 | 12 | 15 | 35 | Sem gabarito oficial; detecção conferida por força bruta |

Os tipos, IDs, timestamps, posições e distâncias dos datasets 1 e 2 coincidiram com os gabaritos; a maior diferença absoluta de distância foi zero. As contagens 3–6 não foram transformadas em gabaritos oficiais.

Para o dataset 7, o oráculo enumerou todos os pares dos 100.000 grupos e reproduziu os 35 encontros, com diferença máxima de distância zero. Ele compartilha o leitor, a fórmula e o classificador com a aplicação: é uma conferência independente da enumeração de candidatos, não uma validação externa dessas regras. A ausência de casos `genericWithVictim` também não confirma A1.

Os resumos completos estão em [final-validation.json](outputs/final-validation.json), a conferência do 7 em [final-oracle-dataset7.json](outputs/final-oracle-dataset7.json) e os hashes em [SHA256SUMS.txt](outputs/SHA256SUMS.txt).

## Evidências de desempenho

As decisões de desempenho usaram o pipeline completo, com inicialização do Node, escrita e conferência dos hashes. Ambiente da comparação principal: Windows, Intel Core i5-1235U, 10 núcleos/12 processadores lógicos, SSD Samsung NVMe, plano de energia SAMSUNG MODE e Node 24.18.0. Foram dez execuções de cada versão, em pares AB/BA intercalados, com cache de arquivos aquecido antes de cada processo novo.

| Dataset 6 — versão | Tempo mínimo total | Tempo mediano total | Mediana dos picos de RSS externos |
|---|---:|---:|---:|
| Inicial | 3.618,45 ms | 4.405,97 ms | 53,75 MiB |
| Entregue | 2.506,77 ms | 2.785,45 ms | 53,47 MiB |

A redução da mediana foi de 36,8%, com saída idêntica em todos os pares. Essa é uma medição neste ambiente, não uma promessa para outros arquivos ou máquinas. Os atalhos de timestamp tiveram ganhos isolados históricos modestos, de 2,17% e 1,26%; permaneceram na base validada e não são apresentados como ganhos isolados de pelo menos 5%.

Uma tentativa posterior de caminho rápido para coordenadas, em Node 22.22.2, melhorou a mediana do microbenchmark em 8,125%, mas só 4,937% no dataset 6 completo. Foi revertida por ficar abaixo do critério de 5%. As hipóteses seguintes, de simplificar o resultado do timestamp e comparar metadados em bloco, não foram executadas após essa parada. Não há workers na entrega.

Para reproduzir a comparação completa e o microbenchmark com os snapshots incluídos no pacote:

```text
npm run benchmark -- outputs/ab-versions-v2/base outputs/ab-versions-v2/timestamp-order
npm run benchmark:parse -- outputs/ab-versions-v3/base outputs/ab-versions-v3/coordinate-fast
```

É preciso disponibilizar os datasets 1–6 para o benchmark completo e o dataset 6 para o microbenchmark. O completo mede externamente tempo e RSS no Windows e registra hardware e plano de energia; não exige RAMMap para essa comparação quente. O microbenchmark usa cerca de 8 MiB já em memória, cinco pares de aquecimento e vinte repetições por versão. Reutiliza o parser real e exclui do tempo informado as cópias de leitura e o hashing dos grupos, sem executar o detector.

Os tempos por etapa usam `process.hrtime.bigint()`. O RSS externo é amostrado e pode perder um pico final; os relatórios guardam também o pico nativo para conferência. Nas 100 execuções medidas da rodada A/B principal, os dois coincidiram. As medições frias históricas usaram RAMMap para limpar o cache do sistema operacional, não o cache interno do SSD; eram sequenciais e não fundamentam a decisão A/B final.

As comparações e suas amostras estão em [ab-comparison-v2.json](outputs/ab-comparison-v2.json) e [round3-parse-comparison.json](outputs/round3-parse-comparison.json). Não há evidência comparativa para afirmar que `readSync` supera streams, que Map supera vetor direto, nem que fundir as funções do leitor seria melhor.

## Conteúdo da entrega

O ZIP reúne este README, `package.json`, código em `src/`, testes e fixtures, scripts de verificação e benchmark, documentação, gabaritos 1–2, os sete JSONs finais, resumos, hashes e evidências selecionadas com snapshots de código para reprodução. Não contém `.git`, os `.txt` de entrada, executáveis do Node/RAMMap nem perfis brutos de CPU.

O histórico de decisões técnicas e as regras de conduta estão em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) e [AGENTS.md](AGENTS.md). O manifesto do pacote registra os arquivos incluídos e seus hashes, exceto o hash do próprio manifesto. O SHA-256 do ZIP acompanha o arquivo final.
