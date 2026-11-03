# Detecção de encontros

Solução do desafio de detecção de encontros entre pessoas monitoradas por tornozeleiras eletrônicas e vítimas que utilizam rastreadores portáteis. A aplicação processa os arquivos de geolocalização e gera um JSON por dataset, com os encontros dos tipos `generico`, `faccao` e `protetiva`.

Implementada em **JavaScript para Node.js 22 ou superior**, sem dependências externas, banco de dados ou serviços auxiliares. Todos os dados do desafio são fictícios.

## Como executar

Execute os comandos na raiz do projeto. Não é necessário rodar `npm install`.

### 1. Inserir o arquivo de entrada

Coloque o arquivo de entrada na pasta `data/`, na raiz do projeto, seu conteúdo deve seguir o formato descrito abaixo.

### 2. Processar o arquivo

Informe o caminho do arquivo de entrada e o caminho desejado para o JSON de saída:

```sh
npm run detect -- data/entrada.txt outputs/encontros.json
```

No PowerShell, caso a política de execução bloqueie `npm.ps1`, use `npm.cmd` no lugar de `npm`. Também é possível executar diretamente:

```sh
node src/cli.js data/entrada.txt outputs/encontros.json
```

Os caminhos de entrada e saída são obrigatórios. Os diretórios de saída são criados automaticamente. Em uma execução bem-sucedida, o arquivo de saída anterior é substituído pelo novo JSON.

Substitua `entrada.txt` pelo nome do seu arquivo e `encontros.json` pelo nome desejado para a saída. Para processar outros arquivos, repita o comando com os respectivos caminhos.

## Formatos de entrada e saída

A entrada é um arquivo de texto separado por ponto e vírgula, com este cabeçalho obrigatório:

```text
idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida
```

| Campo | Conteúdo |
| --- | --- |
| `idMonitorado` | ID numérico da pessoa monitorada ou da vítima. |
| `faccaoMonitorado` | Identificador da facção; pode ser vazio. |
| `timestamp` | Data e hora no formato `YYYY-MM-DD HH:MM:SS`, também aceitas entre aspas duplas. |
| `latitude` / `longitude` | Coordenadas em graus decimais, com ponto como separador decimal. |
| `medidaProtetiva` | Booleano literal `true` ou `false`, que identifica a vítima. |
| `idsRestricaoMedida` | IDs dos agressores separados por vírgula, por exemplo `"1,2,3"`; pode ser vazio. |

A saída é um array JSON com os cinco campos exigidos pelo desafio. Exemplo extraído de `outputs/dataset1.json`:

```json
[
  {
    "tipo": "generico",
    "monitoradosEncontro": [4, 6],
    "timestamp": "2024-01-01 00:05:15",
    "posicoes": {
      "4": { "lat": -31.93195, "lon": -40.61438 },
      "6": { "lat": -31.93187, "lon": -40.61435 }
    },
    "distanciaMetros": 9.33522817789823
  }
]
```

Sem encontros, a saída é `[]`. Os resultados são ordenados por timestamp e, dentro de cada timestamp, pelos IDs dos envolvidos em ordem crescente.

## Lógica utilizada

1. **Leitura e validação:** o arquivo é lido em blocos, validando cabeçalho, IDs, coordenadas, timestamps, booleanos e listas de restrição. Os metadados de cada pessoa são reutilizados enquanto não mudam.
2. **Agrupamento temporal:** apenas registros com o **mesmo timestamp exato** são comparados. O intervalo esperado de cinco segundos não cria tolerância: posições de horários diferentes nunca formam um encontro.
3. **Seleção de candidatos:** dentro de cada grupo, as posições são ordenadas por latitude. Para cada posição, a busca avança apenas enquanto a diferença de latitude permite uma distância menor que 20 metros.
4. **Confirmação da distância:** cada par candidato é avaliado pela fórmula de Haversine. Só é registrado se a distância for **estritamente menor que 20 metros**; exatamente 20 metros não configura encontro.
5. **Classificação e unicidade:** cada par recebe um único tipo e aparece uma única vez naquele timestamp. O mesmo par pode aparecer novamente em outro timestamp.

### Cálculo de distância

A implementação usa o raio terrestre exigido, **R = 6.371.000 metros**:

```text
a = sin²(Δlat / 2) + cos(lat1) × cos(lat2) × sin²(Δlon / 2)
d = 2 × R × asin(√a)
```

As latitudes e diferenças de coordenadas são convertidas para radianos. O valor de `a` é limitado ao intervalo de 0 a 1 para evitar erros numéricos nas operações seguintes. Não há arredondamento da distância na decisão nem na saída.

O filtro de latitude usa `20 / R × 180 / π`, com uma margem conservadora de `10⁻¹²` grau apenas para selecionar candidatos. A confirmação continua sendo `d < 20`, sem tolerância adicional.

### Classificação dos encontros

A prioridade adotada evita registrar o mesmo par em mais de uma categoria:

| Prioridade | Tipo | Regra |
| --- | --- | --- |
| 1 | `protetiva` | Um participante possui medida protetiva e lista o ID do outro em `idsRestricaoMedida`. O vínculo deve existir entre os envolvidos. |
| 2 | `faccao` | Os participantes têm a mesma facção não vazia e não se enquadram na regra anterior. |
| 3 | `generico` | Demais pares dentro do limite de distância. |

**Interpretação adotada:** o código também classifica como `generico` pares que envolvem vítimas quando não existe vínculo de restrição entre os envolvidos nem facção comum preenchida. O enunciado não explicita esse caso; a interpretação é compatível com os dois gabaritos disponíveis, mas não foi confirmada para os datasets sem gabarito. A regra está concentrada em [`src/domain/classify-encounter.js`](src/domain/classify-encounter.js).

## Por que esta abordagem

Considero esta abordagem adequada ao desafio porque reduz comparações desnecessárias sem substituir o cálculo de distância exigido. Agrupar por timestamp elimina pares de horários diferentes; a janela por latitude descarta pares que já estão distantes demais nessa coordenada. Todo par realmente próximo precisa passar por esse filtro, e Haversine decide o resultado final.

A ordenação por latitude usa inserção e reaproveita a ordem do grupo anterior quando os IDs permanecem na mesma sequência. Isso aproveita a proximidade entre posições sucessivas, embora não garanta ganho em todos os dados. A solução usa apenas a biblioteca padrão do Node.js, o que simplifica sua execução e avaliação.

A leitura em blocos evita carregar toda a entrada em memória. Se os timestamps estiverem desordenados, o processamento reinicia com ordenação externa: blocos de até 100.000 registros são ordenados em arquivos temporários e intercalados, preservando a ordem original entre registros do mesmo timestamp. Os temporários são removidos ao final dessa etapa.

Para um grupo de `k` posições, o pior caso é **O(k²)**, tanto pela ordenação por inserção quanto pela quantidade possível de pares candidatos. A janela reduz trabalho em dados espacialmente dispersos, mas não elimina o pior caso quando muitas pessoas estão próximas.

A memória depende do maior grupo temporal, dos metadados dos IDs e dos encontros acumulados. O array de resultados e sua serialização JSON são materializados em memória; uma quantidade muito grande de encontros pode exigir adaptação da escrita. Entradas desordenadas também precisam de espaço temporário em disco.

## Validação e resultados entregues

Os sete datasets foram reprocessados com a implementação atual, sem registros rejeitados, e os resultados coincidiram com os JSONs entregues em `outputs/`.

| Dataset | Arquivo de saída | Encontros | Validação |
| --- | --- | ---: | --- |
| 1 | [dataset1.json](outputs/dataset1.json) | 4 | Igualdade com o gabarito, incluindo distâncias. |
| 2 | [dataset2.json](outputs/dataset2.json) | 6 | Igualdade com o gabarito, incluindo distâncias. |
| 3 | [dataset3.json](outputs/dataset3.json) | 10 | Processamento concluído; sem gabarito fornecido. |
| 4 | [dataset4.json](outputs/dataset4.json) | 15 | Processamento concluído; sem gabarito fornecido. |
| 5 | [dataset5.json](outputs/dataset5.json) | 21 | Processamento concluído; sem gabarito fornecido. |
| 6 | [dataset6.json](outputs/dataset6.json) | 27 | Processamento concluído; sem gabarito fornecido. |
| 7 | [dataset7.json](outputs/dataset7.json) | 35 | Processamento concluído; sem gabarito fornecido. |

As referências são [respostas1.json](https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/respostas1.json) e [respostas2.json](https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/respostas2.json). A comparação foi feita após ler os JSONs, conferindo todos os campos. As contagens dos datasets 3 a 7 não comprovam ausência de falsos positivos ou encontros ausentes.

## Erros e resumo da execução

Duplicatas idênticas do mesmo ID no mesmo timestamp são ignoradas e registradas no log. Dados inválidos ou registros conflitantes para esse ID e timestamp fazem a execução terminar com **código 1**, sem publicar uma saída parcial e preservando o JSON anterior.

Por padrão, as rejeições são registradas em `<saida>.rejects.jsonl`, criado apenas quando há rejeições. É possível escolher outro caminho:

```sh
node src/cli.js data/entrada.txt outputs/encontros.json --rejects outputs/rejeicoes.jsonl
```

O resumo é escrito em `stderr` com o prefixo `Summary:` e contém contagens, encontros por tipo, tempos em milissegundos, uso de CPU e pico de memória RSS. O campo `timingsMs.total` permite acompanhar o tempo de cada execução. Para comparar desempenho, repita as medições no mesmo ambiente; uma execução isolada não representa uma média.

## Estrutura e entrega

```text
src/
  cli.js                     Argumentos e resumo da execução
  process-dataset.js         Coordenação do processamento
  domain/                    Haversine, classificação e detecção
  io/                        Leitura, ordenação externa e escrita
data/                        Arquivos de entrada inseridos pelo usuário
outputs/                     JSONs com os encontros detectados
package.json                 Requisito de Node.js e comando detect
README.md                    Documentação da solução
```