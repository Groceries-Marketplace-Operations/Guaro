-- ============================================================================
-- constraints.sql — Lo que Prisma no expresa.
-- Correr DESPUÉS de `prisma migrate`. Recomendado: pegar este SQL dentro del
-- archivo migration.sql de la migración inicial generada por Prisma, así viaja
-- junto al esquema y nadie olvida aplicarlo.
-- ============================================================================

-- 1) Una app solo se enlaza a una marca del MISMO país (FK compuesto).
--    El @@unique([id, country]) de Application (en schema.prisma) es el objetivo.
ALTER TABLE brand
  ADD CONSTRAINT brand_app_mismo_pais
  FOREIGN KEY (application_id, country) REFERENCES application (id, country);

-- 2) FormValue: exactamente uno de (valor, brand_id, shop_id) por fila.
ALTER TABLE form_value
  ADD CONSTRAINT form_value_un_solo_tipo
  CHECK (num_nonnulls(valor, brand_id, shop_id) = 1);

-- 3) Task: la ventana de programación está completa y es válida.
ALTER TABLE task
  ADD CONSTRAINT task_ventana_completa
    CHECK ((programado_inicio IS NULL) = (programado_fin IS NULL));
ALTER TABLE task
  ADD CONSTRAINT task_ventana_valida
    CHECK (programado_fin IS NULL OR programado_fin > programado_inicio);

-- 4) StepInstance: motivo_fallo solo puede existir si el step falló.
ALTER TABLE step_instance
  ADD CONSTRAINT step_motivo_solo_si_falla
  CHECK (motivo_fallo IS NULL OR estado = 'failed');

-- 5) StepDefinition: only automatic steps can have a handler.
ALTER TABLE step_definition
  ADD CONSTRAINT step_handler_solo_automatico
  CHECK (handler_id IS NULL OR tipo_ejecucion = 'automatic');

-- 6) Account: cada cuenta tiene al menos un rol.
ALTER TABLE account
  ADD CONSTRAINT account_roles_no_vacio
  CHECK (array_length(roles, 1) >= 1);